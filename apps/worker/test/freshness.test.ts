import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateFreshness } from '../src/checks/freshness.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const rule = { version: 1 as const, type: 'freshness' as const, maxAgeMinutes: 60 };
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('freshness rule', () => {
  it('passes up to and including the limit, and fails after it', () => {
    assert.equal(evaluateFreshness(rule, minutesAgo(59), now).status, 'passed');
    assert.equal(evaluateFreshness(rule, minutesAgo(60), now).status, 'passed');
    const late = evaluateFreshness(rule, new Date(minutesAgo(60).getTime() - 1), now);
    assert.equal(late.status, 'failed');
  });

  it('states the condition and the measured age', () => {
    assert.deepEqual(
      evaluateFreshness({ ...rule, timestampColumn: 'updated_at' }, minutesAgo(90), now),
      {
        status: 'failed',
        expected: { maxAgeMinutes: 60, timestampColumn: 'updated_at' },
        actual: { lastUpdatedAt: minutesAgo(90).toISOString(), ageMinutes: 90 },
      },
    );
  });

  it('fails when there is no timestamp at all', () => {
    assert.deepEqual(evaluateFreshness(rule, null, now), {
      status: 'failed',
      expected: { maxAgeMinutes: 60, timestampColumn: null },
      actual: { lastUpdatedAt: null, ageMinutes: null },
    });
  });

  it('treats a timestamp in the future as age zero', () => {
    const result = evaluateFreshness(rule, new Date(now.getTime() + 600_000), now);
    assert.equal(result.status, 'passed');
    assert.equal(result.actual.ageMinutes, 0);
  });
});
