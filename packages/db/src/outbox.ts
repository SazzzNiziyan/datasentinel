import type { Prisma } from './generated/client.js';

export const notificationKinds = [
  'incident_opened',
  'incident_reopened',
  'incident_assigned',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export interface IncidentNotification {
  workspaceId: string;
  incidentId: string;
  /** The incident event this announces; with the recipient it is the
   * idempotency key. */
  incidentEventId: string;
  kind: NotificationKind;
  datasetId: string;
  assignedMembershipId: string | null;
  /** Who caused the event; they are never notified about their own action. */
  actorMembershipId: string | null;
  /** Safe values only (D-86): never secrets or row values. */
  payload: { title: string; severity: string; datasetName: string };
}

async function activeMembers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  ids: readonly (string | null)[],
): Promise<string[]> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return [];
  const rows = await tx.membership.findMany({
    where: { workspaceId, status: 'active', id: { in: wanted } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** The owners to tell about a dataset's incident (D-86): the dataset's
 * owner if that member is still active, else the source's owner, else the
 * workspace owners, so an incident never goes unannounced. */
async function owners(tx: Prisma.TransactionClient, n: IncidentNotification): Promise<string[]> {
  const dataset = await tx.dataset.findFirst({
    where: { id: n.datasetId, workspaceId: n.workspaceId },
    select: { ownerMembershipId: true, source: { select: { ownerMembershipId: true } } },
  });
  const byDataset = await activeMembers(tx, n.workspaceId, [dataset?.ownerMembershipId ?? null]);
  if (byDataset.length > 0) return byDataset;
  const bySource = await activeMembers(tx, n.workspaceId, [
    dataset?.source.ownerMembershipId ?? null,
  ]);
  if (bySource.length > 0) return bySource;
  const rows = await tx.membership.findMany({
    where: { workspaceId: n.workspaceId, status: 'active', role: 'owner' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Writes the pending notifications for one incident event, inside the
 * caller's transaction, so the change and its notification commit together
 * or not at all (D-86). Opened: the owners. Reopened: the owners and the
 * assignee. Assigned: the assignee. Writing the same event again adds
 * nothing. Returns how many rows were written. */
export async function enqueueIncidentNotification(
  tx: Prisma.TransactionClient,
  n: IncidentNotification,
): Promise<number> {
  const assignee = await activeMembers(tx, n.workspaceId, [n.assignedMembershipId]);
  const candidates =
    n.kind === 'incident_assigned'
      ? assignee
      : n.kind === 'incident_reopened'
        ? [...(await owners(tx, n)), ...assignee]
        : await owners(tx, n);
  const recipients = [...new Set(candidates)].filter((id) => id !== n.actorMembershipId);
  if (recipients.length === 0) return 0;
  const written = await tx.notificationOutbox.createManyAndReturn({
    data: recipients.map((recipientMembershipId) => ({
      workspaceId: n.workspaceId,
      incidentId: n.incidentId,
      incidentEventId: n.incidentEventId,
      recipientMembershipId,
      kind: n.kind,
      payload: n.payload,
    })),
    skipDuplicates: true,
    select: { id: true },
  });
  return written.length;
}
