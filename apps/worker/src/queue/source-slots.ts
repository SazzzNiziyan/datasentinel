import { ConnectorFailure } from '@datasentinel/connectors';
import type { Redis } from 'ioredis';

/** Caps how many sessions DataSentinel holds on one source at a time,
 * across every worker process (D-54). */
export interface SourceSlots {
  /** Runs `work` in a slot, or rejects with ConnectorFailure('busy'). */
  run<T>(sourceId: string, work: () => Promise<T>): Promise<T>;
}

/** No cap; for tests and single-shot scripts. */
export const unlimitedSlots: SourceSlots = { run: (_sourceId, work) => work() };

// Atomic: count up, refresh the expiry, and give the slot back at once
// when over the limit. The expiry frees slots of a crashed worker.
const ACQUIRE = `
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1`;

const RELEASE = `
local n = redis.call('DECR', KEYS[1])
if n <= 0 then redis.call('DEL', KEYS[1]) end
return n`;

export class RedisSourceSlots implements SourceSlots {
  constructor(
    private readonly redis: Redis,
    private readonly limit = 2,
    private readonly ttlSeconds = 120,
  ) {}

  async run<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const key = `datasentinel:source-slots:${sourceId}`;
    const got = await this.redis.eval(ACQUIRE, 1, key, this.limit, this.ttlSeconds);
    if (got !== 1) throw new ConnectorFailure('busy');
    try {
      return await work();
    } finally {
      await this.redis.eval(RELEASE, 1, key).catch(() => {});
    }
  }
}
