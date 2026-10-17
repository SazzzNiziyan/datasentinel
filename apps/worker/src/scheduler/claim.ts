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

/** Claims every enabled schedule due at `now` (D-70). Rows are locked with
 * SKIP LOCKED, so parallel schedulers split the work instead of waiting,
 * and the occurrence's unique (schedule, time) key makes a second claim of
 * the same due time a no-op. Each schedule moves on to its first due time
 * after `now`: missed times are counted, not run. A schedule whose stored
 * definition no longer validates is paused rather than guessed at. */
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
    const claimed: ClaimedOccurrence[] = [];
    for (const row of due) {
      const parsed = validateSchedule(row.definition);
      if (!parsed.ok) {
        await tx.schedule.update({ where: { id: row.id }, data: { nextRunAt: null } });
        continue;
      }
      let next = nextOccurrence(parsed.definition, row.nextRunAt, row.anchorAt);
      let missed = 0;
      while (next.getTime() <= now.getTime() && missed < MISSED_LIMIT) {
        missed += 1;
        next = nextOccurrence(parsed.definition, next, row.anchorAt);
      }
      if (next.getTime() <= now.getTime()) next = nextOccurrence(parsed.definition, now, row.anchorAt);
      const created = await tx.scheduleOccurrence.createManyAndReturn({
        data: [
          {
            workspaceId: row.workspaceId,
            scheduleId: row.id,
            scheduledFor: row.nextRunAt,
            missedBefore: missed,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      await tx.schedule.update({
        where: { id: row.id },
        data: { nextRunAt: next, lastRunAt: now },
      });
      const occurrence = created[0];
      if (occurrence !== undefined) {
        claimed.push({
          id: occurrence.id,
          workspaceId: row.workspaceId,
          scheduleId: row.id,
          scheduledFor: row.nextRunAt,
          missedBefore: missed,
        });
      }
    }
    return claimed;
  });
}
