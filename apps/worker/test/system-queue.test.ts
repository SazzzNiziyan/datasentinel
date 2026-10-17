import 'reflect-metadata';
import { PING_JOB, SYSTEM_QUEUE, type PingJobData } from '@datasentinel/contracts';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PARSE_UPLOAD_DEPS } from '../src/queue/upload-queue.service.js';
import { WorkerModule } from '../src/worker.module.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** True when local Redis answers (pnpm services:up). */
async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

// Integration test: needs Redis, so it is skipped when services are down.
const skip = !(await redisAvailable()) && 'local Redis is not running (pnpm services:up)';

describe('worker round trip through Redis', { skip }, () => {
  let moduleRef: TestingModule;
  let queue: Queue<PingJobData>;
  let events: QueueEvents;

  before(async () => {
    // Boots the real module graph, so a broken injection fails here.
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule.register({ logLevel: 'silent', redisUrl })],
    })
      // Upload jobs need the database and storage; this test does not.
      .overrideProvider(PARSE_UPLOAD_DEPS)
      .useValue({ prisma: { $disconnect: () => Promise.resolve() }, open: () => null })
      .compile();
    await moduleRef.init();
    queue = new Queue(SYSTEM_QUEUE, { connection: { url: redisUrl } });
    events = new QueueEvents(SYSTEM_QUEUE, { connection: { url: redisUrl } });
    await events.waitUntilReady();
  });

  after(async () => {
    await events.close();
    await queue.close();
    await moduleRef.close();
  });

  it('processes a ping job and returns its answer', async () => {
    const job = await queue.add(PING_JOB, { sentAt: '2026-10-17T00:00:00.000Z' });
    assert.deepEqual(await job.waitUntilFinished(events, 5000), {
      pong: true,
      sentAt: '2026-10-17T00:00:00.000Z',
    });
  });
});
