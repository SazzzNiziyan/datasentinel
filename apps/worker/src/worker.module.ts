import { loadWorkerEnv } from '@datasentinel/config';
import { createPrismaClient } from '@datasentinel/db';
import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Level } from 'pino';
import {
  SystemQueueService,
  WORKER_OPTIONS,
  type WorkerOptions,
} from './queue/system-queue.service.js';
import { PARSE_UPLOAD_DEPS, UploadQueueService } from './queue/upload-queue.service.js';
import { s3ObjectOpener } from './storage/object-opener.js';

export interface WorkerModuleOptions extends WorkerOptions {
  logLevel: Level | 'silent';
}

/** Background jobs only; no HTTP server. */
@Module({})
export class WorkerModule {
  static register({ logLevel, ...options }: WorkerModuleOptions): DynamicModule {
    return {
      module: WorkerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: { level: logLevel } })],
      providers: [
        { provide: WORKER_OPTIONS, useValue: options },
        SystemQueueService,
        {
          provide: PARSE_UPLOAD_DEPS,
          // Database and storage settings are read here, so tests can
          // replace this provider without them.
          useFactory: () => {
            const env = loadWorkerEnv();
            return {
              prisma: createPrismaClient(env.DATABASE_URL),
              open: s3ObjectOpener(env),
            };
          },
        },
        UploadQueueService,
      ],
    };
  }
}
