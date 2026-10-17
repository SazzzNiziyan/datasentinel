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
import { jobOptions, PARSE_UPLOAD_JOB, SOURCE_QUEUE, UPLOAD_QUEUE } from '@datasentinel/contracts';
import { Queue } from 'bullmq';
import { ACTION_DEPS, ActionService, type ActionServiceDeps } from './actions/actions.service.js';
import { DEFAULT_LLM_LIMITS, prismaUsageLedger, unconfiguredLlm } from './ai/llm.js';
import {
  INVESTIGATION_DEPS,
  InvestigationService,
  type InvestigationServiceDeps,
} from './ai/investigation.service.js';
import { postJson } from './delivery/deliver-slack.js';
import { postSigned } from './delivery/deliver-webhook.js';
import { unconfiguredEmail } from './delivery/deliver-email.js';
import { DELIVERY_DEPS, DeliveryService, type DeliveryDeps } from './delivery/delivery.service.js';
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

/** An uploads-queue producer for retried imports (D-118); connects on first
 * use. The caller supplies the job id so a repeat is queued once. */
function uploadsProducer(redisUrl: string): ActionServiceDeps['enqueueParse'] {
  let queue: Queue | undefined;
  return async (data, jobId) => {
    queue ??= new Queue(UPLOAD_QUEUE, {
      connection: new Redis(redisUrl, { maxRetriesPerRequest: 1 }),
    });
    await queue.add(PARSE_UPLOAD_JOB, data, jobOptions(PARSE_UPLOAD_JOB, jobId));
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
              {
                provide: DELIVERY_DEPS,
                useFactory: (): DeliveryDeps => {
                  const env = loadWorkerEnv();
                  return {
                    prisma: createPrismaClient(env.DATABASE_URL),
                    email: unconfiguredEmail,
                    ring: keyRing({
                      key: env.SECRETS_ENCRYPTION_KEY,
                      version: env.SECRETS_ENCRYPTION_KEY_VERSION,
                      previous: env.SECRETS_ENCRYPTION_PREVIOUS_KEYS,
                    }),
                    post: postJson,
                    policy: env.SOURCE_NETWORK_POLICY,
                    postWebhook: postSigned,
                    features: {
                      github: env.FEATURE_DESTINATION_GITHUB,
                      n8n: env.FEATURE_DESTINATION_N8N,
                    },
                    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
                  };
                },
              },
              DeliveryService,
              {
                provide: INVESTIGATION_DEPS,
                useFactory: (): InvestigationServiceDeps => {
                  const env = loadWorkerEnv();
                  const prisma = createPrismaClient(env.DATABASE_URL);
                  return {
                    prisma,
                    // No provider is bundled (D-101): reports fail visibly until one is wired in.
                    llm: {
                      provider: unconfiguredLlm,
                      ledger: prismaUsageLedger(prisma),
                      limits: {
                        ...DEFAULT_LLM_LIMITS,
                        dailyTokenBudget: env.AI_DAILY_TOKEN_BUDGET,
                      },
                    },
                    config: {
                      available:
                        env.FEATURE_AI &&
                        env.AI_PROVIDER_NAME !== undefined &&
                        env.AI_PROVIDER_REGION !== undefined &&
                        env.AI_RETENTION_NOTE !== undefined,
                      providerName: env.AI_PROVIDER_NAME ?? null,
                    },
                  };
                },
              },
              InvestigationService,
              {
                provide: ACTION_DEPS,
                useFactory: (): ActionServiceDeps => {
                  const env = loadWorkerEnv();
                  return {
                    prisma: createPrismaClient(env.DATABASE_URL),
                    enqueue: sourcesProducer(env.REDIS_URL),
                    enqueueParse: uploadsProducer(env.REDIS_URL),
                    features: {
                      github: env.FEATURE_DESTINATION_GITHUB,
                      n8n: env.FEATURE_DESTINATION_N8N,
                    },
                  };
                },
              },
              ActionService,
            ]
          : []),
      ],
    };
  }
}
