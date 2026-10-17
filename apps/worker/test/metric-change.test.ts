import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateMetricChange, median } from '../src/checks/metric-change.js';

const rule = (limits: { maxIncreasePercent?: number; maxDropPercent?: number }) => ({
  version: 1 as const,
  type: 'metric_change' as const,
  metric: 'row_count' as const,
  comparisonWindowDays: 7 as const,
  minimumHistoryPoints: 3,
  ...limits,
});
const observedAt = new Date('2026-10-17T12:00:00.000Z');
const current = (value: number) => ({ value, method: 'exact' as const, observedAt });

describe('metric change rule', () => {
  it('takes the median, averaging the middle pair', () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it('states window, baseline, current value, and differences', () => {
    const result = evaluateMetricChange(rule({ maxDropPercent: 30 }), current(60), [100, 90, 110]);
    assert.deepEqual(result, {
      status: 'failed',
      expected: {
        metric: 'row_count',
        column: null,
        comparisonWindowDays: 7,
        baseline: 'median',
        minimumHistoryPoints: 3,
        maxIncreasePercent: null,
        maxDropPercent: 30,
      },
      actual: {
        current: 60,
        currentMethod: 'exact',
        baseline: 100,
        absoluteChange: -40,
        percentChange: -40,
        historyPoints: 3,
        windowStart: '2026-10-10T12:00:00.000Z',
        windowEnd: '2026-10-17T12:00:00.000Z',
      },
    });
  });

  it('includes the limits and checks each direction only when set', () => {
    assert.equal(
      evaluateMetricChange(rule({ maxDropPercent: 40 }), current(60), [100, 100, 100]).status,
      'passed',
    );
    assert.equal(
      evaluateMetricChange(rule({ maxDropPercent: 40 }), current(500), [100, 100, 100]).status,
      'passed',
    );
    assert.equal(
      evaluateMetricChange(rule({ maxIncreasePercent: 50 }), current(151), [100, 100, 100]).status,
      'failed',
    );
  });

  it('returns insufficient_data when history is too short', () => {
    const result = evaluateMetricChange(rule({ maxDropPercent: 1 }), current(1), [1, 1]);
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.actual.historyPoints, 2);
    assert.equal(result.actual.reason, 'short_history');
    assert.equal(
      evaluateMetricChange(rule({ maxDropPercent: 1 }), null, [1, 1, 1]).status,
      'insufficient_data',
    );
  });

  it('treats any rise from a zero baseline as an unbounded increase', () => {
    const result = evaluateMetricChange(rule({ maxIncreasePercent: 1000 }), current(1), [0, 0, 0]);
    assert.equal(result.status, 'failed');
    assert.equal(result.actual.percentChange, null);
    assert.equal(
      evaluateMetricChange(rule({ maxDropPercent: 10 }), current(0), [0, 0, 0]).status,
      'passed',
    );
  });
});
