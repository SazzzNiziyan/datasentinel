import { safeNotificationPayload } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';

type OutboxRow = {
  id: string;
  workspaceId: string;
  incidentId: string;
  incidentEventId: string;
  kind: string;
  payload: unknown;
};

/** Turns pending outbox rows into one delivery per (incident event, active
 * destination that wants the kind), D-89. Claims use SKIP LOCKED, the
 * deliveries' unique key makes a repeat harmless, and the rows are marked
 * handed-off in the same transaction, so a crash either redoes the whole
 * step or none of it. Rows with no matching destination are `suppressed`:
 * recorded, not retried. */
export async function fanOutOutbox(
  prisma: PrismaClient,
  now: Date,
  limit = 100,
  /** Only this workspace's rows; the running service passes none. */
  workspaceId: string | null = null,
): Promise<{ events: number; deliveries: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, workspace_id AS "workspaceId", incident_id AS "incidentId",
             incident_event_id AS "incidentEventId", kind, payload
        FROM notification_outbox
       WHERE status = 'pending' AND next_attempt_at <= ${now}
         AND (${workspaceId}::uuid IS NULL OR workspace_id = ${workspaceId}::uuid)
       ORDER BY created_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return { events: 0, deliveries: 0 };

    const byEvent = new Map<string, OutboxRow[]>();
    for (const row of rows)
      byEvent.set(row.incidentEventId, [...(byEvent.get(row.incidentEventId) ?? []), row]);

    let deliveries = 0;
    const sent: string[] = [];
    const suppressed: string[] = [];
    for (const group of byEvent.values()) {
      const first = group[0]!;
      const destinations = await tx.destination.findMany({
        where: { workspaceId: first.workspaceId, status: 'active', events: { has: first.kind } },
        select: { id: true },
      });
      if (destinations.length > 0) {
        const made = await tx.notificationDelivery.createMany({
          data: destinations.map((d) => ({
            workspaceId: first.workspaceId,
            incidentId: first.incidentId,
            incidentEventId: first.incidentEventId,
            destinationId: d.id,
            kind: first.kind,
            payload: safeNotificationPayload(first.payload),
          })),
          skipDuplicates: true,
        });
        deliveries += made.count;
      }
      (destinations.length > 0 ? sent : suppressed).push(...group.map((r) => r.id));
    }
    if (sent.length > 0) {
      await tx.notificationOutbox.updateMany({
        where: { id: { in: sent } },
        data: { status: 'sent', sentAt: now },
      });
    }
    if (suppressed.length > 0) {
      await tx.notificationOutbox.updateMany({
        where: { id: { in: suppressed } },
        data: { status: 'suppressed' },
      });
    }
    return { events: byEvent.size, deliveries };
  });
}
