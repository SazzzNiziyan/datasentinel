import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DuplicateCounter, evaluateUniqueness } from '../src/checks/uniqueness.js';

const rule = (maxDuplicateRows = 0) => ({
  version: 1 as const,
  type: 'uniqueness' as const,
  columns: ['id'],
  maxDuplicateRows,
});

describe('uniqueness rule', () => {
  it('counts extra copies and repeated keys, skipping keys with an empty part', () => {
    const counter = new DuplicateCounter();
    for (const key of [
      ['1', 'a'],
      ['2', 'a'],
      ['1', 'a'],
      ['1', 'a'],
      ['2', 'a'],
      ['3', ''],
    ]) {
      counter.add(key);
    }
    counter.add(['', '']);
    assert.deepEqual(counter.result(), { rowCount: 7, duplicateRows: 3, duplicateKeys: 2 });
  });

  it('does not confuse keys whose parts join to the same text', () => {
    const counter = new DuplicateCounter();
    counter.add(['a,b', 'c']);
    counter.add(['a', 'b,c']);
    assert.equal(counter.result().duplicateRows, 0);
  });

  it('passes up to maxDuplicateRows and fails above it', () => {
    const counts = { rowCount: 10, duplicateRows: 2, duplicateKeys: 1 };
    assert.equal(evaluateUniqueness(rule(2), counts).status, 'passed');
    assert.deepEqual(evaluateUniqueness(rule(1), counts), {
      status: 'failed',
      expected: { columns: ['id'], maxDuplicateRows: 1 },
      actual: counts,
    });
  });

  it('reports an empty dataset as insufficient data', () => {
    const empty = { rowCount: 0, duplicateRows: 0, duplicateKeys: 0 };
    assert.equal(evaluateUniqueness(rule(), empty).status, 'insufficient_data');
  });
});
