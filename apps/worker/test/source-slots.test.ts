import { ConnectorFailure } from '@datasentinel/connectors';
import { Redis } from 'ioredis';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { RedisSourceSlots } from '../src/queue/source-slots.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  lazyConnect: true,
  connectTimeout: 500,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
redis.on('error', () => {});
const skip = await redis.connect().then(
  () => false,
  () => 'local Redis is not running (pnpm services:up)',
);

describe('per-source session slots', { skip }, () => {
  after(() => redis.disconnect());

  it('refuses work beyond the limit and frees the slot afterwards', async () => {
    const slots = new RedisSourceSlots(redis, 1, 30);
    const source = randomUUID();
    let release!: () => void;
    const holding = slots.run(source, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      slots.run(source, () => Promise.resolve('second')),
      (e: unknown) => e instanceof ConnectorFailure && e.code === 'busy',
    );
    // Another source is not affected.
    assert.equal(await slots.run(randomUUID(), () => Promise.resolve('other')), 'other');
    release();
    await holding;
    assert.equal(await slots.run(source, () => Promise.resolve('again')), 'again');
    assert.equal(await redis.exists(`datasentinel:source-slots:${source}`), 0);
  });

  it('frees the slot when the work fails', async () => {
    const slots = new RedisSourceSlots(redis, 1, 30);
    const source = randomUUID();
    await assert.rejects(slots.run(source, () => Promise.reject(new Error('boom'))));
    assert.equal(await slots.run(source, () => Promise.resolve('ok')), 'ok');
  });
});
