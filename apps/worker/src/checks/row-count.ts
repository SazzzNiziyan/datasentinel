import type { RuleDefinition } from '@datasentinel/contracts';
import type { CheckOutcome } from './outcome.js';

/** Row count (D-62): passes while `minRows <= rows <= maxRows`, bounds
 * included and either one optional. An empty dataset is measured, not
 * skipped: zero rows below a minimum is the failure this rule exists for.
 * An estimate is compared as given and marked approximate. */
export function evaluateRowCount(
  rule: Extract<RuleDefinition, { type: 'row_count' }>,
  { rowCount, method }: { rowCount: number; method: 'exact' | 'approximate' },
): CheckOutcome {
  const tooFew = rule.minRows !== undefined && rowCount < rule.minRows;
  const tooMany = rule.maxRows !== undefined && rowCount > rule.maxRows;
  return {
    status: tooFew || tooMany ? 'failed' : 'passed',
    expected: { minRows: rule.minRows ?? null, maxRows: rule.maxRows ?? null },
    actual: { rowCount, rowCountMethod: method },
  };
}
