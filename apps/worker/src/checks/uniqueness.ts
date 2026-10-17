import type { RuleDefinition } from '@datasentinel/contracts';
import { createHash } from 'node:crypto';
import type { CheckOutcome } from './outcome.js';

export type DuplicateCounts = {
  rowCount: number;
  /** Rows beyond the first for each repeated key. */
  duplicateRows: number;
  /** Keys that appear more than once. */
  duplicateKeys: number;
};

/** Counts repeated keys in one pass for CSV files (D-61). Only a 16-byte
 * hash of each key is kept, never the values, and memory is bounded by the
 * scan limit checked before the pass. Keys with an empty part are skipped,
 * as a database UNIQUE constraint skips nulls. */
export class DuplicateCounter {
  private readonly seen = new Set<string>();
  private readonly repeated = new Set<string>();
  private rows = 0;
  private extra = 0;

  add(key: readonly string[]): void {
    this.rows += 1;
    if (key.some((part) => part.trim() === '')) return;
    // JSON keeps ["a,b","c"] and ["a","b,c"] apart.
    const hash = createHash('sha256').update(JSON.stringify(key)).digest('base64').slice(0, 22);
    if (!this.seen.has(hash)) {
      this.seen.add(hash);
      return;
    }
    this.extra += 1;
    this.repeated.add(hash);
  }

  result(): DuplicateCounts {
    return { rowCount: this.rows, duplicateRows: this.extra, duplicateKeys: this.repeated.size };
  }
}

/** Uniqueness (D-61): passes while duplicate rows are at most
 * `maxDuplicateRows`. An empty dataset is insufficient_data. */
export function evaluateUniqueness(
  rule: Extract<RuleDefinition, { type: 'uniqueness' }>,
  counts: DuplicateCounts,
): CheckOutcome {
  const expected = { columns: rule.columns, maxDuplicateRows: rule.maxDuplicateRows };
  if (counts.rowCount === 0) {
    return { status: 'insufficient_data', expected, actual: { rowCount: 0, reason: 'no_rows' } };
  }
  return {
    status: counts.duplicateRows <= rule.maxDuplicateRows ? 'passed' : 'failed',
    expected,
    actual: { ...counts },
  };
}
