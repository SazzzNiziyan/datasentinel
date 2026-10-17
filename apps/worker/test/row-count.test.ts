import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateRowCount } from '../src/checks/row-count.js';

const rule = (bounds: { minRows?: number; maxRows?: number }) => ({
  version: 1 as const,
  type: 'row_count' as const,
  ...bounds,
});
const exact = (rowCount: number) => ({ rowCount, method: 'exact' as const });

describe('row-count rule', () => {
  it('includes both bounds', () => {
    const both = rule({ minRows: 10, maxRows: 20 });
    assert.equal(evaluateRowCount(both, exact(9)).status, 'failed');
    assert.equal(evaluateRowCount(both, exact(10)).status, 'passed');
    assert.equal(evaluateRowCount(both, exact(20)).status, 'passed');
    assert.equal(evaluateRowCount(both, exact(21)).status, 'failed');
  });

  it('fails an empty dataset below a minimum, and checks one bound alone', () => {
    assert.deepEqual(evaluateRowCount(rule({ minRows: 1 }), exact(0)), {
      status: 'failed',
      expected: { minRows: 1, maxRows: null },
      actual: { rowCount: 0, rowCountMethod: 'exact' },
    });
    assert.equal(evaluateRowCount(rule({ maxRows: 5 }), exact(0)).status, 'passed');
  });

  it('marks an estimate as approximate', () => {
    const result = evaluateRowCount(rule({ minRows: 1 }), {
      rowCount: 2_000_000,
      method: 'approximate',
    });
    assert.equal(result.actual.rowCountMethod, 'approximate');
  });
});
