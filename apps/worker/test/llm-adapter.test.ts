import { createPrismaClient } from '@datasentinel/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, describe, it } from 'node:test';
import {
  callLlm,
  DEFAULT_LLM_LIMITS,
  estimateTokens,
  LlmError,
  prismaUsageLedger,
  unconfiguredLlm,
  usageDay,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type UsageLedger,
} from '../src/ai/llm.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const prisma = createPrismaClient(databaseUrl || 'postgresql://unused@127.0.0.1:1/unused');
const skip =
  databaseUrl === ''
    ? 'DATABASE_URL is not set'
    : await prisma.$queryRaw`SELECT 1`.then(
        () => false,
        () => 'local database is not running (pnpm services:up)',
      );

const request: LlmRequest = { system: 'sys', user: 'SECRET-USER-TEXT', maxOutputTokens: 100 };
const ok = (over: Partial<LlmResponse> = {}): LlmResponse => ({
  text: '{}',
  inputTokens: 10,
  outputTokens: 20,
  ...over,
});

/** In-memory ledger recording what the adapter asked of it. */
function memoryLedger(allow = true) {
  const calls: string[] = [];
  let tokens = 0;
  const ledger: UsageLedger = {
    reserve: (_w, _d, n) => {
      calls.push(`reserve:${n}`);
      if (!allow) return Promise.resolve(false);
      tokens += n;
      return Promise.resolve(true);
    },
    adjust: (_w, _d, delta) => {
      calls.push(`adjust:${delta}`);
      tokens += delta;
      return Promise.resolve();
    },
  };
  return { ledger, calls, tokens: () => tokens };
}

const limits = { ...DEFAULT_LLM_LIMITS, dailyTokenBudget: 10_000, timeoutMs: 200 };

function setup(provider: LlmProvider, allow = true) {
  const sleeps: number[] = [];
  const m = memoryLedger(allow);
  return {
    sleeps,
    ...m,
    deps: {
      provider,
      ledger: m.ledger,
      limits,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

const failing = (...errors: (LlmError | Error | 'ok')[]) => {
  let n = 0;
  const calls = { n: 0 };
  const provider: LlmProvider = {
    complete: () => {
      calls.n += 1;
      const next = errors[Math.min(n, errors.length - 1)];
      n += 1;
      return next === 'ok' || next === undefined ? Promise.resolve(ok()) : Promise.reject(next);
    },
  };
  return { provider, calls };
};

describe('provider-neutral LLM adapter', () => {
  it('returns the response and settles the reservation to the provider’s own count', async () => {
    const { provider, calls } = failing('ok');
    const s = setup(provider);
    const reserved = estimateTokens('sys'.length + request.user.length) + 100;
    assert.deepEqual(await callLlm(s.deps, 'w', request), ok());
    assert.equal(calls.n, 1);
    assert.deepEqual(s.calls, [`reserve:${reserved}`, `adjust:${30 - reserved}`]);
    assert.equal(s.tokens(), 30);
  });

  it('retries errors that can pass, with backoff, up to the attempt limit', async () => {
    const recovers = failing(
      new LlmError('rate_limited', true),
      new LlmError('unavailable', true),
      'ok',
    );
    const a = setup(recovers.provider);
    await callLlm(a.deps, 'w', request);
    assert.equal(recovers.calls.n, 3);
    assert.deepEqual(a.sleeps, [1000, 4000]);

    const never = failing(new LlmError('unavailable', true));
    const b = setup(never.provider);
    await assert.rejects(callLlm(b.deps, 'w', request), { name: 'LlmError', code: 'unavailable' });
    assert.equal(never.calls.n, DEFAULT_LLM_LIMITS.maxAttempts);
    assert.equal(b.tokens(), 0, 'the reservation is given back');
  });

  it('stops at once on errors that cannot pass, and gives the reservation back', async () => {
    const rejected = failing(new LlmError('rejected', false));
    const s = setup(rejected.provider);
    await assert.rejects(callLlm(s.deps, 'w', request), { code: 'rejected' });
    assert.equal(rejected.calls.n, 1);
    assert.deepEqual(s.sleeps, []);
    assert.equal(s.tokens(), 0);
  });

  it('gives each attempt a deadline and reports a timeout', async () => {
    const hangs: LlmProvider = {
      complete: (_r, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    };
    const s = setup(hangs);
    await assert.rejects(callLlm(s.deps, 'w', request), { code: 'timeout' });
    assert.equal(s.tokens(), 0);
  });

  it('refuses oversized input and an exhausted budget without calling the provider', async () => {
    const { provider, calls } = failing('ok');
    const big = setup(provider);
    await assert.rejects(
      callLlm(big.deps, 'w', { ...request, user: 'x'.repeat(limits.maxInputChars) }),
      { code: 'input_too_large' },
    );
    assert.deepEqual(big.calls, []);

    const broke = setup(provider, false);
    await assert.rejects(callLlm(broke.deps, 'w', request), { code: 'budget_exceeded' });
    assert.equal(calls.n, 0);
  });

  it('rejects an oversized or malformed response without retrying', async () => {
    for (const bad of [
      ok({ text: 'x'.repeat(limits.maxOutputChars + 1) }),
      ok({ inputTokens: Number.NaN }),
      { text: 5 } as unknown as LlmResponse,
    ]) {
      let n = 0;
      const s = setup({
        complete: () => {
          n += 1;
          return Promise.resolve(bad);
        },
      });
      await assert.rejects(callLlm(s.deps, 'w', request), { code: 'invalid_response' });
      assert.equal(n, 1);
      assert.equal(s.tokens(), 0);
    }
  });

  it('never puts the prompt or provider text into an error', async () => {
    const s = setup({
      complete: () => Promise.reject(new Error('provider said: SECRET-USER-TEXT sk-abc')),
    });
    const error = await callLlm(s.deps, 'w', request).catch((e: unknown) => e);
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'unavailable');
    assert.equal(JSON.stringify([error.message, error.code]).includes('SECRET-USER-TEXT'), false);
    assert.equal(error.message.includes('sk-abc'), false);
  });

  it('fails visibly until a provider is configured', async () => {
    await assert.rejects(unconfiguredLlm.complete(request, AbortSignal.timeout(100)), {
      code: 'unavailable',
      retryable: false,
    });
  });

  it('counts a call against the UTC day', () => {
    assert.equal(
      usageDay(new Date('2026-10-17T23:59:59.999Z')).toISOString(),
      '2026-10-17T00:00:00.000Z',
    );
    assert.equal(
      usageDay(new Date('2026-10-18T00:00:00.000Z')).toISOString(),
      '2026-10-18T00:00:00.000Z',
    );
  });
});

describe('daily token budget in the database', { skip }, () => {
  let workspaces: string[] = [];
  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    workspaces = [];
  });
  after(() => prisma.$disconnect());

  const workspace = async () => {
    const w = await prisma.workspace.create({ data: { name: 'B', slug: `b-${randomUUID()}` } });
    workspaces.push(w.id);
    return w.id;
  };
  const used = async (id: string, day: Date) =>
    (await prisma.aiUsageDaily.findUnique({ where: { workspaceId_day: { workspaceId: id, day } } }))
      ?.tokens;

  it('lets concurrent calls spend the budget exactly once, never more', async () => {
    const id = await workspace();
    const ledger = prismaUsageLedger(prisma);
    const day = usageDay(new Date());
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.reserve(id, day, 30, 100)),
    );
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(await used(id, day), 90);
    assert.equal(await ledger.reserve(id, day, 11, 100), false);
    assert.equal(await used(id, day), 90, 'a refused reservation takes nothing');
    assert.equal(await ledger.reserve(id, day, 10, 100), true);
    assert.equal(await ledger.reserve(randomUUID().length > 0 ? id : id, day, 1, 100), false);
  });

  it('refuses a reservation larger than the whole budget, and counts days separately', async () => {
    const id = await workspace();
    const ledger = prismaUsageLedger(prisma);
    const today = usageDay(new Date('2026-10-17T10:00:00Z'));
    const tomorrow = usageDay(new Date('2026-10-18T10:00:00Z'));
    assert.equal(await ledger.reserve(id, today, 101, 100), false);
    assert.equal(await used(id, today), undefined);
    assert.equal(await ledger.reserve(id, today, 100, 100), true);
    assert.equal(await ledger.reserve(id, tomorrow, 100, 100), true);
  });

  it('gives tokens back and never goes below zero', async () => {
    const id = await workspace();
    const ledger = prismaUsageLedger(prisma);
    const day = usageDay(new Date());
    await ledger.reserve(id, day, 50, 100);
    await ledger.adjust(id, day, -20);
    assert.equal(await used(id, day), 30);
    await ledger.adjust(id, day, -500);
    assert.equal(await used(id, day), 0);
  });
});
