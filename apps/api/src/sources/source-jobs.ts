import {
  DISCOVER_TABLES_JOB,
  jobOptions,
  PROFILE_DATASET_JOB,
  RUN_CHECK_JOB,
  SOURCE_QUEUE,
  TEST_CONNECTION_JOB,
  type DiscoverTablesJobData,
  type DiscoveryOutcome,
  type ProfileDatasetJobData,
  type RunCheckJobData,
  type TestConnectionJobData,
} from '@datasentinel/contracts';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

/** Jobs that touch a source's database; only the worker connects to it.
 * Tests replace this. */
export interface SourceJobs {
  enqueueTest(data: TestConnectionJobData): Promise<void>;
  enqueueProfile(data: ProfileDatasetJobData): Promise<void>;
  enqueueCheck(data: RunCheckJobData): Promise<void>;
  /** Waits for the worker's answer; null when it did not come in time. */
  discover(data: DiscoverTablesJobData, timeoutMs: number): Promise<DiscoveryOutcome | null>;
}

export const SOURCE_JOBS = Symbol('SOURCE_JOBS');

/** BullMQ producer for the sources queue, connecting on first use. */
export class BullSourceJobs implements SourceJobs, OnApplicationShutdown {
  private open?: { connection: Redis; queue: Queue; events: QueueEvents };

  constructor(private readonly redisUrl: string) {}

  private get bull() {
    if (this.open === undefined) {
      const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: 1 });
      this.open = {
        connection,
        queue: new Queue(SOURCE_QUEUE, { connection }),
        // QueueEvents blocks on Redis, so it gets its own connection.
        events: new QueueEvents(SOURCE_QUEUE, { connection: { url: this.redisUrl } }),
      };
    }
    return this.open;
  }

  /** One attempt: the user asked for this test now, and the result says
   * whether to try again. The job ID is the test ID. */
  async enqueueTest(data: TestConnectionJobData): Promise<void> {
    await this.bull.queue.add(
      TEST_CONNECTION_JOB,
      data,
      jobOptions(TEST_CONNECTION_JOB, data.connectionTestId),
    );
  }

  /** The job ID is the run's, so a repeated request cannot queue it twice;
   * the worker also claims the run only once (D-59). */
  async enqueueCheck(data: RunCheckJobData): Promise<void> {
    await this.bull.queue.add(
      RUN_CHECK_JOB,
      data,
      jobOptions(RUN_CHECK_JOB, `check-${data.checkRunId}`),
    );
  }

  /** One pending run per dataset: the job ID repeats until it finishes. */
  async enqueueProfile(data: ProfileDatasetJobData): Promise<void> {
    await this.bull.queue.add(
      PROFILE_DATASET_JOB,
      data,
      jobOptions(PROFILE_DATASET_JOB, `profile-${data.datasetId}`),
    );
  }

  /** The answer holds table names only and leaves Redis within a minute. */
  async discover(data: DiscoverTablesJobData, timeoutMs: number): Promise<DiscoveryOutcome | null> {
    const { queue, events } = this.bull;
    await events.waitUntilReady();
    const job = await queue.add(
      DISCOVER_TABLES_JOB,
      data,
      jobOptions(DISCOVER_TABLES_JOB, randomUUID()),
    );
    try {
      return (await job.waitUntilFinished(events, timeoutMs)) as DiscoveryOutcome;
    } catch {
      return null;
    }
  }

  async onApplicationShutdown() {
    await this.open?.events.close();
    await this.open?.queue.close();
    this.open?.connection.disconnect();
  }
}
