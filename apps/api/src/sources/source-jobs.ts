import {
  DISCOVER_TABLES_JOB,
  PROFILE_DATASET_JOB,
  SOURCE_QUEUE,
  TEST_CONNECTION_JOB,
  type DiscoverTablesJobData,
  type DiscoveryOutcome,
  type ProfileDatasetJobData,
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
    await this.bull.queue.add(TEST_CONNECTION_JOB, data, {
      jobId: data.connectionTestId,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  /** One pending run per dataset: the job ID repeats until it finishes. */
  async enqueueProfile(data: ProfileDatasetJobData): Promise<void> {
    await this.bull.queue.add(PROFILE_DATASET_JOB, data, {
      jobId: `profile-${data.datasetId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** The answer holds table names only and leaves Redis within a minute. */
  async discover(data: DiscoverTablesJobData, timeoutMs: number): Promise<DiscoveryOutcome | null> {
    const { queue, events } = this.bull;
    await events.waitUntilReady();
    const job = await queue.add(DISCOVER_TABLES_JOB, data, {
      jobId: randomUUID(),
      removeOnComplete: { age: 60 },
      removeOnFail: { age: 60 },
    });
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
