import {
  jobOptions,
  PARSE_UPLOAD_JOB,
  UPLOAD_QUEUE as QUEUE_NAME,
  type ParseUploadJobData,
} from '@datasentinel/contracts';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** Sends upload jobs to the worker; tests replace it. */
export interface UploadQueue {
  enqueueParse(data: ParseUploadJobData): Promise<void>;
}

export const UPLOAD_QUEUE = Symbol('UPLOAD_QUEUE');

/** BullMQ producer. The job ID is the upload ID, so adding the same upload
 * again is a no-op while the job exists. Connects on the first job. */
export class BullUploadQueue implements UploadQueue, OnApplicationShutdown {
  private queue?: { connection: Redis; queue: Queue<ParseUploadJobData> };

  constructor(private readonly redisUrl: string) {}

  async enqueueParse(data: ParseUploadJobData): Promise<void> {
    if (this.queue === undefined) {
      const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: 1 });
      this.queue = { connection, queue: new Queue(QUEUE_NAME, { connection }) };
    }
    await this.queue.queue.add(PARSE_UPLOAD_JOB, data, jobOptions(PARSE_UPLOAD_JOB, data.uploadId));
  }

  async onApplicationShutdown() {
    await this.queue?.queue.close();
    this.queue?.connection.disconnect();
  }
}
