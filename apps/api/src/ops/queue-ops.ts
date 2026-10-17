import {
  redactRunSummary,
  SOURCE_QUEUE,
  UPLOAD_QUEUE,
  type QueueJobList,
  type QueueJobSummary,
} from '@datasentinel/contracts';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_OPS = Symbol('QUEUE_OPS');

/** A job still waiting or running this long after it was added is stalled. */
export const STALLED_AFTER_MS = 15 * 60_000;
const SHOWN = 100;
const READ_PER_QUEUE = 500;

/** What the queue knows about one job; `workspaceId` comes from its data. */
export interface RawQueueJob {
  queue: string;
  id: string;
  name: string;
  state: 'failed' | 'waiting' | 'active';
  workspaceId: string | null;
  attemptsMade: number;
  attempts: number;
  addedAt: number;
  finishedAt: number | null;
  failedReason: string | null;
}

export interface QueueOps {
  list(): Promise<RawQueueJob[]>;
}

/** The workspace's failed and stalled jobs, newest first (D-78). Jobs of
 * other workspaces never appear, and failure text is redacted. */
export function operatorJobs(
  raw: readonly RawQueueJob[],
  workspaceId: string,
  now: Date,
  state?: 'failed' | 'stalled',
): QueueJobList {
  const found: QueueJobSummary[] = [];
  for (const job of raw) {
    if (job.workspaceId !== workspaceId) continue;
    const kind =
      job.state === 'failed'
        ? 'failed'
        : now.getTime() - job.addedAt > STALLED_AFTER_MS
          ? 'stalled'
          : null;
    if (kind === null || (state !== undefined && state !== kind)) continue;
    const firstLine = job.failedReason?.split('\n')[0] ?? '';
    found.push({
      queue: job.queue,
      jobId: job.id,
      name: job.name,
      state: kind,
      attemptsMade: job.attemptsMade,
      attempts: job.attempts,
      addedAt: new Date(job.addedAt).toISOString(),
      finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
      failure: firstLine === '' ? null : redactRunSummary(firstLine).slice(0, 200),
    });
  }
  found.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0));
  return { jobs: found.slice(0, SHOWN), omitted: Math.max(0, found.length - SHOWN) };
}

/** Reads failed, waiting, and active jobs from Redis. Read-only. */
export class BullQueueOps implements QueueOps, OnApplicationShutdown {
  private open?: { connection: Redis; queues: Queue[] };

  constructor(private readonly redisUrl: string) {}

  private get bull() {
    if (this.open === undefined) {
      const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: 1 });
      this.open = {
        connection,
        queues: [SOURCE_QUEUE, UPLOAD_QUEUE].map((name) => new Queue(name, { connection })),
      };
    }
    return this.open;
  }

  async list(): Promise<RawQueueJob[]> {
    const out: RawQueueJob[] = [];
    for (const queue of this.bull.queues) {
      for (const types of [['failed'], ['waiting', 'active']] as const) {
        const jobs = await queue.getJobs([...types], 0, READ_PER_QUEUE - 1);
        for (const job of jobs) {
          const data = job.data as { workspaceId?: unknown } | undefined;
          out.push({
            queue: queue.name,
            id: job.id ?? '',
            name: job.name,
            state: types[0] === 'failed' ? 'failed' : job.processedOn ? 'active' : 'waiting',
            workspaceId: typeof data?.workspaceId === 'string' ? data.workspaceId : null,
            attemptsMade: job.attemptsMade,
            attempts: job.opts.attempts ?? 1,
            addedAt: job.timestamp,
            finishedAt: job.finishedOn ?? null,
            failedReason: job.failedReason ?? null,
          });
        }
      }
    }
    return out;
  }

  async onApplicationShutdown() {
    await Promise.all(this.open?.queues.map((q) => q.close()) ?? []);
    this.open?.connection.disconnect();
  }
}
