import type { OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export interface RateLimiter {
  /** Counts one attempt; false when the key is over its limit. */
  consume(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

/** Fixed-window counters in Redis, shared by every API instance. */
export class RedisRateLimiter implements RateLimiter, OnApplicationShutdown {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => {});
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const name = `ratelimit:${key}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(name)
      .expire(name, windowSeconds, 'NX')
      .exec()) as [[null, number], unknown];
    return count <= limit;
  }

  onApplicationShutdown() {
    this.redis.disconnect();
  }
}

/** In-process counters, for tests. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  consume(key: string, limit: number): Promise<boolean> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return Promise.resolve(count <= limit);
  }
}
