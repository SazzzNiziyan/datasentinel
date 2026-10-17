import { nextOccurrence, validateSchedule } from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';

/** Stops counting missed due times after this many (a long outage). */
const MISSED_LIMIT = 10_000;

export type ClaimedOccurrence = {
  id: string;
  workspaceId: string;
  scheduleId: string;
  scheduledFor: Date;
  missedBefore: number;
};

type DueRow = {
  id: string;
  workspaceId: string;
  definition: unknown;
  anchorAt: Date;
  nextRunAt: Date;
};

/** Where one due schedule goes next; `next` is null to pause it. */
type Plan = { row: DueRow; next: Date | null; missed: number };

function plan(row: DueRow, now: Date): Plan {
  const parsed = validateSchedule(row.definition);
  if (!parsed.ok) return { row, next: null, missed: 0 };
  let next = nextOccurrence(parsed.definition, row.nextRunAt, row.anchorAt);
  let missed = 0;
  while (next.getTime() <= now.getTime() && missed < MISSED_LIMIT) {
    missed += 1;
    next = nextOccurrence(parsed.definition, next, row.anchorAt);
  }
  if (next.getTime() <= now.getTime()) next = nextOccurrence(parsed.definition, now, row.anchorAt);
  return { row, next, missed };
}

/** Claims every enabled schedule due at `now` (D-70). Rows are locked with
 * SKIP LOCKED, so parallel schedulers split the work instead of waiting,
 * and the occurrence's unique (schedule, time) key makes a second claim of
 * the same due time a no-op. Each schedule moves on to its first due time
 * after `now`: missed times are counted, not run. A schedule whose stored
 * definition no longer validates is paused rather than guessed at. A pass
 * is three statements however many schedules are due. */
export async function claimDueOccurrences(
  prisma: PrismaClient,
  now: Date,
  limit = 100,
): Promise<ClaimedOccurrence[]> {
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<DueRow[]>`
      SELECT id, workspace_id AS "workspaceId", definition,
             anchor_at AS "anchorAt", next_run_at AS "nextRunAt"
        FROM schedules
       WHERE enabled AND next_run_at <= ${now}
       ORDER BY next_run_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED`;
    if (due.length === 0) return [];
    const plans = due.map((row) => plan(row, now));
    const runnable = plans.filter((p) => p.next !== null);
    const created =
      runnable.length === 0
        ? []
        : await tx.scheduleOccurrence.createManyAndReturn({
            data: runnable.map(({ row, missed }) => ({
              workspaceId: row.workspaceId,
              scheduleId: row.id,
              scheduledFor: row.nextRunAt,
              missedBefore: missed,
            })),
            skipDuplicates: true,
            select: { id: true, scheduleId: true },
          });
    // A paused schedule keeps its last run time.
    await tx.$executeRaw`
      UPDATE schedules AS s
         SET next_run_at = v.next::timestamptz,
             last_run_at = CASE WHEN v.next IS NULL THEN s.last_run_at ELSE ${now} END,
             updated_at = now()
        FROM unnest(${plans.map((p) => p.row.id)}::text[],
                    ${plans.map((p) => p.next?.toISOString() ?? null)}::text[]) AS v(id, next)
       WHERE s.id = v.id::uuid`;
    const byId = new Map(runnable.map((p) => [p.row.id, p]));
    return created.flatMap(({ id, scheduleId }) => {
      const p = byId.get(scheduleId);
      return p === undefined
        ? []
        : [
            {
              id,
              workspaceId: p.row.workspaceId,
              scheduleId,
              scheduledFor: p.row.nextRunAt,
              missedBefore: p.missed,
            },
          ];
    });
  });
}

/** Occurrences claimed before `before` whose jobs were never queued: the
 * claiming process stopped, or the queue was down, between claim and
 * dispatch (D-70). Dispatching one again is safe: its check runs and job
 * IDs are keyed by the occurrence. */
export function strandedOccurrences(
  prisma: PrismaClient,
  before: Date,
  limit = 100,
): Promise<ClaimedOccurrence[]> {
  return prisma.scheduleOccurrence.findMany({
    where: { status: 'pending', createdAt: { lt: before } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      workspaceId: true,
      scheduleId: true,
      scheduledFor: true,
      missedBefore: true,
    },
  });
}
