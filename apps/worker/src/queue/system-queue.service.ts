import { PING_JOB, SYSTEM_QUEUE, type PingJobData } from '@datasentinel/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { handlePing } from '../jobs/ping.js';

export const WORKER_OPTIONS = Symbol('WORKER_OPTIONS');

export interface WorkerOptions {
  redisUrl: string;
}

/** Consumes the system queue. Logs job IDs and names only, never job data. */
@Injectable()
export class SystemQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SystemQueueService.name);
  private connection?: Redis;
  private worker?: Worker;

  constructor(@Inject(WORKER_OPTIONS) private readonly options: WorkerOptions) {}

  onApplicationBootstrap() {
    // BullMQ workers block on Redis, so retries must not be capped.
    this.connection = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(SYSTEM_QUEUE, (job: Job) => this.process(job), {
      connection: this.connection,
    });
    this.worker.on('completed', (job) => this.logger.log(`job ${job.id} (${job.name}) completed`));
    this.worker.on('failed', (job) =>
      this.logger.warn(`job ${job?.id ?? 'unknown'} (${job?.name ?? 'unknown'}) failed`),
    );
    this.worker.on('error', () => this.logger.error('queue connection error'));
  }

  async onApplicationShutdown() {
    // Lets the running job finish before the process exits.
    await this.worker?.close();
    this.connection?.disconnect();
  }

  private process(job: Job) {
    switch (job.name) {
      case PING_JOB:
        return Promise.resolve(handlePing(job.data as PingJobData));
      default:
        return Promise.reject(new Error(`Unknown job name: ${job.name}`));
    }
  }
}
