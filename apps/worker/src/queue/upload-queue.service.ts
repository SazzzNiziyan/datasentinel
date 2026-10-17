import { PARSE_UPLOAD_JOB, UPLOAD_QUEUE, type ParseUploadJobData } from '@datasentinel/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { handleParseUpload, type ParseUploadDeps } from '../jobs/parse-upload.js';
import { WORKER_OPTIONS, type WorkerOptions } from './system-queue.service.js';

export const PARSE_UPLOAD_DEPS = Symbol('PARSE_UPLOAD_DEPS');

/** Consumes the uploads queue. Logs job IDs and names only, never data. */
@Injectable()
export class UploadQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(UploadQueueService.name);
  private connection?: Redis;
  private worker?: Worker<ParseUploadJobData>;

  constructor(
    @Inject(WORKER_OPTIONS) private readonly options: WorkerOptions,
    @Inject(PARSE_UPLOAD_DEPS) private readonly deps: ParseUploadDeps,
  ) {}

  onApplicationBootstrap() {
    this.connection = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<ParseUploadJobData>(UPLOAD_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      // Each job holds at most one row in memory, so a few can run at once.
      concurrency: 2,
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
    await this.deps.prisma.$disconnect();
  }

  private process(job: Job<ParseUploadJobData>) {
    if (job.name !== PARSE_UPLOAD_JOB) {
      return Promise.reject(new Error(`Unknown job name: ${job.name}`));
    }
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return handleParseUpload(this.deps, job.data, { finalAttempt });
  }
}
