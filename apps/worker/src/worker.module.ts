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
import { SourceQueueService, TEST_CONNECTION_DEPS } from './queue/source-queue.service.js';
import { keyRing } from '@datasentinel/connectors';
import { Redis } from 'ioredis';
import { RedisSourceSlots } from './queue/source-slots.js';
import { s3ObjectOpener } from './storage/object-opener.js';
import { jobOptions, SOURCE_QUEUE } from '@datasentinel/contracts';
import { Queue } from 'bullmq';
import { dispatchOccurrence, type Enqueue } from './scheduler/dispatch.js';
import {
  SCHEDULER_DEPS,
  SchedulerService,
  type SchedulerDeps,
} from './scheduler/scheduler.service.js';

export interface WorkerModuleOptions extends WorkerOptions {
  logLevel: Level | 'silent';
  /** Runs the schedule ticker (D-70); off in tests. */
  scheduler?: boolean;
}

/** A sources-queue producer that connects on first use and adds each
 * batch in one round trip (D-71). */
function sourcesProducer(redisUrl: string): Enqueue {
  let queue: Queue | undefined;
  return async (jobs) => {
    if (jobs.length === 0) return;
    queue ??= new Queue(SOURCE_QUEUE, {
      connection: new Redis(redisUrl, { maxRetriesPerRequest: 1 }),
    });
    await queue.addBulk(
      jobs.map(({ name, data, jobId }) => ({ name, data, opts: jobOptions(name, jobId) })),
    );
  };
}

/** Background jobs only; no HTTP server. */
@Module({})
export class WorkerModule {
  static register({ logLevel, scheduler = false, ...options }: WorkerModuleOptions): DynamicModule {
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
        {
          provide: TEST_CONNECTION_DEPS,
          // Keys and policy come from the environment (D-46, D-48).
          useFactory: () => {
            const env = loadWorkerEnv();
            return {
              prisma: createPrismaClient(env.DATABASE_URL),
              ring: keyRing({
                key: env.SECRETS_ENCRYPTION_KEY,
                version: env.SECRETS_ENCRYPTION_KEY_VERSION,
                previous: env.SECRETS_ENCRYPTION_PREVIOUS_KEYS,
              }),
              policy: env.SOURCE_NETWORK_POLICY,
              open: s3ObjectOpener(env),
              enqueue: sourcesProducer(env.REDIS_URL),
              slots: new RedisSourceSlots(new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 })),
            };
          },
        },
        SourceQueueService,
        ...(scheduler
          ? [
              {
                provide: SCHEDULER_DEPS,
                useFactory: (): SchedulerDeps => {
                  const env = loadWorkerEnv();
                  const deps = {
                    prisma: createPrismaClient(env.DATABASE_URL),
                    enqueue: sourcesProducer(env.REDIS_URL),
                  };
                  return { prisma: deps.prisma, dispatch: (o) => dispatchOccurrence(deps, o) };
                },
              },
              SchedulerService,
            ]
          : []),
      ],
    };
  }
}
