import {
  PROFILE_DATASET_JOB,
  RUN_CHECK_JOB,
  type ProfileDatasetJobData,
  type RunCheckJobData,
} from '@datasentinel/contracts';
import type { PrismaClient } from '@datasentinel/db';
import type { ClaimedOccurrence } from './claim.js';

/** Adds one job to the sources queue; the job ID dedupes repeats. */
export type Enqueue = (
  name: string,
  data: ProfileDatasetJobData | RunCheckJobData,
  jobId: string,
) => Promise<void>;

export interface DispatchDeps {
  prisma: PrismaClient;
  enqueue: Enqueue;
}

/** Queues the work of one claimed occurrence (D-71), or records why it was
 * skipped: the dataset or its source is not active, or a check from an
 * earlier occurrence of the same schedule is still queued or running.
 * A database dataset is profiled first and its rules follow the profile;
 * otherwise the checks are queued at once. */
export async function dispatchOccurrence(
  deps: DispatchDeps,
  occurrence: ClaimedOccurrence,
): Promise<void> {
  const { prisma } = deps;
  const schedule = await prisma.schedule.findUnique({
    where: { id: occurrence.scheduleId },
    select: {
      targetType: true,
      datasetId: true,
      dataset: { select: { status: true, source: { select: { type: true, status: true } } } },
    },
  });
  const finish = (data: { status: 'enqueued' } | { status: 'skipped'; skipReason: string }) =>
    prisma.scheduleOccurrence.update({ where: { id: occurrence.id }, data });
  if (schedule === null) return;
  if (schedule.dataset.status !== 'active' || schedule.dataset.source.status !== 'active') {
    await finish({ status: 'skipped', skipReason: 'dataset_not_active' });
    return;
  }
  const busy = await prisma.checkRun.count({
    where: {
      workspaceId: occurrence.workspaceId,
      status: { in: ['queued', 'running'] },
      occurrence: { scheduleId: occurrence.scheduleId },
    },
  });
  if (busy > 0) {
    await finish({ status: 'skipped', skipReason: 'previous_still_running' });
    return;
  }
  if (schedule.targetType === 'dataset' && schedule.dataset.source.type === 'postgres') {
    await deps.enqueue(
      PROFILE_DATASET_JOB,
      {
        workspaceId: occurrence.workspaceId,
        datasetId: schedule.datasetId,
        occurrenceId: occurrence.id,
      },
      `profile-${schedule.datasetId}-${occurrence.id}`,
    );
  } else {
    await queueScheduledChecks(deps, occurrence.id);
  }
  await finish({ status: 'enqueued' });
}

/** Creates and queues one check run per enabled rule of the occurrence's
 * target, at the rule's current revision. The idempotency key
 * `schedule:{occurrenceId}:{ruleId}` makes a repeat create nothing new. */
export async function queueScheduledChecks(
  { prisma, enqueue }: DispatchDeps,
  occurrenceId: string,
): Promise<number> {
  const occurrence = await prisma.scheduleOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      workspaceId: true,
      schedule: { select: { targetType: true, datasetId: true, ruleId: true } },
    },
  });
  if (occurrence === null) return 0;
  const { workspaceId, schedule } = occurrence;
  const rules = await prisma.qualityRule.findMany({
    where: {
      workspaceId,
      enabled: true,
      ...(schedule.targetType === 'rule' && schedule.ruleId !== null
        ? { id: schedule.ruleId }
        : { datasetId: schedule.datasetId }),
    },
    select: {
      id: true,
      revisions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
    },
  });
  let queued = 0;
  for (const rule of rules) {
    const revisionId = rule.revisions[0]?.id;
    if (revisionId === undefined) continue;
    const idempotencyKey = `schedule:${occurrenceId}:${rule.id}`;
    await prisma.checkRun.createMany({
      data: [
        {
          workspaceId,
          ruleId: rule.id,
          ruleRevisionId: revisionId,
          trigger: 'schedule',
          idempotencyKey,
          occurrenceId,
        },
      ],
      skipDuplicates: true,
    });
    const run = await prisma.checkRun.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      select: { id: true, status: true },
    });
    if (run?.status !== 'queued') continue;
    await enqueue(RUN_CHECK_JOB, { workspaceId, checkRunId: run.id }, `check-${run.id}`);
    queued += 1;
  }
  return queued;
}
