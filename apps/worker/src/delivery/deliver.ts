import type { Destination, NotificationDelivery, PrismaClient } from '@datasentinel/db';
import { DELIVERY_MAX_ATTEMPTS, deliveryBackoffMs } from '@datasentinel/contracts';
import { isNotificationKind, type DeliveryKind } from './email-template.js';

export type SendResult =
  { ok: true; messageId?: string } | { ok: false; retryable: boolean; reason: string };

export type DeliveryTarget = { delivery: NotificationDelivery; destination: Destination };

/** A claimed delivery that is never finished becomes due again after this. */
export const LEASE_MS = 5 * 60_000;

/** Stored reasons are short codes, never provider text (D-89). */
const safeReason = (reason: string): string =>
  /^[a-z0-9_]{1,60}$/.test(reason) ? reason : 'send_failed';

/** Sends due deliveries of one destination type and records each result
 * (D-89). The claim moves the due time forward by a lease (SKIP LOCKED), so
 * parallel workers never double-send and a crashed worker's delivery comes
 * back later. Retry policy beyond the lease is Phase K's retry item. */
export async function deliverDue(
  prisma: PrismaClient,
  type: 'email' | 'slack' | 'webhook' | 'github' | 'n8n',
  now: Date,
  limit: number,
  send: (target: DeliveryTarget, kind: DeliveryKind) => Promise<SendResult>,
  /** Only these workspaces' deliveries; the running service passes none. */
  workspaceIds: string[] | null = null,
): Promise<{ sent: number; failed: number; suppressed: number; retrying: number }> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE notification_deliveries
       SET next_attempt_at = ${lease}
     WHERE id IN (
       SELECT d.id
         FROM notification_deliveries d
         JOIN destinations x ON x.workspace_id = d.workspace_id AND x.id = d.destination_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ${now}
          AND x.type = ${type}::"DestinationType"
          AND (${workspaceIds}::uuid[] IS NULL OR d.workspace_id = ANY(${workspaceIds}::uuid[]))
        ORDER BY d.next_attempt_at
        LIMIT ${limit}
          FOR UPDATE OF d SKIP LOCKED)
    RETURNING id`;
  const result = { sent: 0, failed: 0, suppressed: 0, retrying: 0 };
  for (const { id } of claimed) {
    const row = await prisma.notificationDelivery.findUnique({
      where: { id },
      include: { destination: true },
    });
    if (row === null || row.status !== 'pending') continue;
    const { destination, ...delivery } = row;
    const pending = { where: { id, status: 'pending' as const } };

    if (destination.status !== 'active') {
      await prisma.notificationDelivery.updateMany({
        ...pending,
        data: { status: 'suppressed', lastError: 'destination_inactive' },
      });
      result.suppressed += 1;
      continue;
    }
    if (!isNotificationKind(delivery.kind)) {
      await prisma.notificationDelivery.updateMany({
        ...pending,
        data: { status: 'failed', attempts: { increment: 1 }, lastError: 'unknown_kind' },
      });
      result.failed += 1;
      continue;
    }

    let outcome: SendResult;
    try {
      outcome = await send({ delivery, destination }, delivery.kind);
    } catch {
      outcome = { ok: false, retryable: true, reason: 'transport_error' };
    }
    if (outcome.ok) {
      await prisma.notificationDelivery.updateMany({
        ...pending,
        data: { status: 'sent', sentAt: now, attempts: { increment: 1 }, lastError: null },
      });
      result.sent += 1;
    } else {
      const attempts = delivery.attempts + 1;
      const again = outcome.retryable && attempts < DELIVERY_MAX_ATTEMPTS;
      await prisma.notificationDelivery.updateMany({
        ...pending,
        data: {
          // Retryable failures stay pending with a later due time; the rest stop.
          status: again ? 'pending' : 'failed',
          attempts,
          lastError: safeReason(outcome.reason),
          ...(again
            ? { nextAttemptAt: new Date(now.getTime() + deliveryBackoffMs(attempts)) }
            : {}),
        },
      });
      result[again ? 'retrying' : 'failed'] += 1;
    }
  }
  return result;
}

/** Fails every due delivery of a type whose feature flag is off, with a
 * reason an admin can read, instead of leaving it waiting forever (D-96).
 * After the flag is turned back on, an admin can retry them. */
export const deliverDisabled = (
  prisma: PrismaClient,
  type: 'email' | 'slack' | 'webhook' | 'github' | 'n8n',
  now: Date,
  limit = 20,
  workspaceIds: string[] | null = null,
) =>
  deliverDue(
    prisma,
    type,
    now,
    limit,
    () => Promise.resolve({ ok: false, retryable: false, reason: 'feature_disabled' }),
    workspaceIds,
  );
