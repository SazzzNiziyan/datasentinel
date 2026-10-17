import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RangeCounter, evaluateRange, parseCsvValue, rangeBounds } from '../src/checks/range.js';

const rule = (min?: number | string, max?: number | string) => ({
  version: 1 as const,
  type: 'range' as const,
  column: 'x',
  ...(min === undefined ? {} : { min }),
  ...(max === undefined ? {} : { max }),
});
const day = 86_400_000;

describe('range rule', () => {
  it('turns numeric bounds into an inclusive range', () => {
    assert.deepEqual(rangeBounds(rule(0, 10)), {
      kind: 'number',
      low: 0,
      high: 10,
      highInclusive: true,
    });
    assert.deepEqual(rangeBounds(rule(undefined, 5)), {
      kind: 'number',
      low: null,
      high: 5,
      highInclusive: true,
    });
  });

  it('lets a date-only maximum cover its whole UTC day', () => {
    const bounds = rangeBounds(rule('2026-01-01', '2026-01-31'));
    assert.equal(bounds.kind, 'time');
    assert.equal(bounds.low, Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(bounds.high, Date.parse('2026-01-31T00:00:00Z') + day);
    assert.equal(bounds.highInclusive, false);
    const exactTime = rangeBounds(rule(undefined, '2026-01-31T12:00:00+02:00'));
    assert.equal(exactTime.high, Date.parse('2026-01-31T10:00:00Z'));
    assert.equal(exactTime.highInclusive, true);
  });

  it('counts values below and above, bounds included', () => {
    const counter = new RangeCounter(rangeBounds(rule(0, 10)));
    for (const v of [-1, 0, 5, 10, 11, 12]) counter.add(v);
    assert.deepEqual(counter.result(), { valuesChecked: 6, belowMin: 1, aboveMax: 2 });
    const days = new RangeCounter(rangeBounds(rule(undefined, '2026-01-31')));
    days.add(Date.parse('2026-01-31T23:59:59Z'));
    days.add(Date.parse('2026-02-01T00:00:00Z'));
    assert.deepEqual(days.result(), { valuesChecked: 2, belowMin: 0, aboveMax: 1 });
  });

  it('reads CSV numbers, dates, and timestamps, without a zone as UTC', () => {
    assert.equal(parseCsvValue('number', ' 1.5e2 '), 150);
    assert.equal(parseCsvValue('number', ''), null);
    assert.equal(parseCsvValue('time', '2026-01-02'), Date.parse('2026-01-02T00:00:00Z'));
    assert.equal(parseCsvValue('time', '2026-01-02 03:04'), Date.parse('2026-01-02T03:04:00Z'));
    assert.equal(
      parseCsvValue('time', '2026-01-02T03:04:05+0530'),
      Date.parse('2026-01-02T03:04:05+05:30'),
    );
    assert.equal(parseCsvValue('time', 'soon'), null);
  });

  it('passes with no value outside, and needs at least one value', () => {
    const r = rule(0, 10);
    assert.deepEqual(evaluateRange(r, { valuesChecked: 3, belowMin: 0, aboveMax: 0 }), {
      status: 'passed',
      expected: { column: 'x', min: 0, max: 10 },
      actual: { valuesChecked: 3, belowMin: 0, aboveMax: 0 },
    });
    assert.equal(evaluateRange(r, { valuesChecked: 3, belowMin: 0, aboveMax: 1 }).status, 'failed');
    assert.equal(
      evaluateRange(r, { valuesChecked: 0, belowMin: 0, aboveMax: 0 }).status,
      'insufficient_data',
    );
  });
});
