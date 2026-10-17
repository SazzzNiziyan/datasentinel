import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateNotNull } from '../src/checks/not-null.js';

const rule = (maxNullPercent: number) => ({
  version: 1 as const,
  type: 'not_null' as const,
  column: 'email',
  maxNullPercent,
});

describe('not-null rule', () => {
  it('passes at the limit and fails just above it', () => {
    assert.equal(evaluateNotNull(rule(0), { rowCount: 10, nullCount: 0 }).status, 'passed');
    assert.equal(evaluateNotNull(rule(0), { rowCount: 10, nullCount: 1 }).status, 'failed');
    assert.equal(evaluateNotNull(rule(10), { rowCount: 10, nullCount: 1 }).status, 'passed');
    assert.equal(evaluateNotNull(rule(10), { rowCount: 3, nullCount: 1 }).status, 'failed');
  });

  it('compares the exact share, not the rounded one', () => {
    // 1 of 3 is 33.333...%, shown as 33.33 but above a 33.33 limit.
    const result = evaluateNotNull(rule(33.33), { rowCount: 3, nullCount: 1 });
    assert.deepEqual(result, {
      status: 'failed',
      expected: { column: 'email', maxNullPercent: 33.33 },
      actual: { rowCount: 3, nullCount: 1, nullPercent: 33.33 },
    });
  });

  it('reports an empty dataset as insufficient data', () => {
    assert.equal(
      evaluateNotNull(rule(0), { rowCount: 0, nullCount: 0 }).status,
      'insufficient_data',
    );
  });
});
