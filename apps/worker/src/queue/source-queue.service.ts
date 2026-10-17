import {
  DISCOVER_TABLES_JOB,
  PROFILE_DATASET_JOB,
  RUN_CHECK_JOB,
  SOURCE_QUEUE,
  TEST_CONNECTION_JOB,
  type DiscoverTablesJobData,
  type ProfileDatasetJobData,
  type RunCheckJobData,
  type TestConnectionJobData,
} from '@datasentinel/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { handleDiscoverTables } from '../jobs/discover-tables.js';
import { handleProfileDataset } from '../jobs/profile-dataset.js';
import { handleRunCheck } from '../jobs/run-check.js';
import { queueScheduledChecks } from '../scheduler/dispatch.js';
import { handleTestConnection, type TestConnectionDeps } from '../jobs/test-connection.js';
import { WORKER_OPTIONS, type WorkerOptions } from './system-queue.service.js';

export const TEST_CONNECTION_DEPS = Symbol('TEST_CONNECTION_DEPS');

/** Consumes the sources queue. Logs job IDs and names only, never data. */
@Injectable()
export class SourceQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SourceQueueService.name);
  private connection?: Redis;
  private worker?: Worker;

  constructor(
    @Inject(WORKER_OPTIONS) private readonly options: WorkerOptions,
    @Inject(TEST_CONNECTION_DEPS) private readonly deps: TestConnectionDeps,
  ) {}

  onApplicationBootstrap() {
    this.connection = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(SOURCE_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      // Each test holds one short-lived connection to a customer database.
      concurrency: 4,
    });
    this.worker.on('completed', (job) => this.logger.log(`job ${job.id} (${job.name}) completed`));
    this.worker.on('failed', (job) =>
      this.logger.warn(`job ${job?.id ?? 'unknown'} (${job?.name ?? 'unknown'}) failed`),
    );
    this.worker.on('error', () => this.logger.error('queue connection error'));
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    this.connection?.disconnect();
  }

  private async process(job: Job) {
    switch (job.name) {
      case TEST_CONNECTION_JOB: {
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        return handleTestConnection(this.deps, job.data as TestConnectionJobData, {
          finalAttempt,
        });
      }
      case PROFILE_DATASET_JOB: {
        const data = job.data as ProfileDatasetJobData;
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        // A scheduled profile is followed by the dataset's checks, also
        // when the profile failed for good (D-71).
        const followUp = () =>
          data.occurrenceId === undefined || this.deps.enqueue === undefined
            ? Promise.resolve(0)
            : queueScheduledChecks(
                { prisma: this.deps.prisma, enqueue: this.deps.enqueue },
                data.occurrenceId,
              );
        try {
          await handleProfileDataset(this.deps, data, { finalAttempt });
        } catch (error) {
          if (finalAttempt) await followUp();
          throw error;
        }
        await followUp();
        return;
      }
      case RUN_CHECK_JOB: {
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        return handleRunCheck(this.deps, job.data as RunCheckJobData, { finalAttempt });
      }
      case DISCOVER_TABLES_JOB:
        return handleDiscoverTables(this.deps, job.data as DiscoverTablesJobData);
      default:
        return Promise.reject(new Error(`Unknown job name: ${job.name}`));
    }
  }
}
