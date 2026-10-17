import type { RuleDefinition } from '@datasentinel/contracts';
import type { CheckOutcome } from './outcome.js';

/** Not-null (D-60): passes while the column's null share is at most
 * `maxNullPercent`, limit included. An empty dataset is insufficient_data,
 * since "no nulls in no rows" says nothing. */
export function evaluateNotNull(
  rule: Extract<RuleDefinition, { type: 'not_null' }>,
  { rowCount, nullCount }: { rowCount: number; nullCount: number },
): CheckOutcome {
  const expected = { column: rule.column, maxNullPercent: rule.maxNullPercent };
  if (rowCount === 0) {
    return { status: 'insufficient_data', expected, actual: { rowCount: 0, reason: 'no_rows' } };
  }
  // Compared without rounding; the stored percent is rounded for display.
  const share = (nullCount / rowCount) * 100;
  return {
    status: share <= rule.maxNullPercent ? 'passed' : 'failed',
    expected,
    actual: { rowCount, nullCount, nullPercent: Math.round(share * 100) / 100 },
  };
}
