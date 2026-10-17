import type { RuleDefinition } from '@datasentinel/contracts';
import type { CheckOutcome } from './outcome.js';

type RangeRule = Extract<RuleDefinition, { type: 'range' }>;

/** Numbers, or times as epoch milliseconds. */
export type RangeKind = 'number' | 'time';

export type RangeBounds = {
  kind: RangeKind;
  /** Inclusive; null when unset. */
  low: number | null;
  high: number | null;
  /** False for a date-only maximum, which covers its whole UTC day. */
  highInclusive: boolean;
};

export type RangeCounts = { valuesChecked: number; belowMin: number; aboveMax: number };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The rule's bounds in comparable form (D-63). Validation (D-58) already
 * made both bounds the same kind. Date-only bounds are UTC days. */
export function rangeBounds(rule: RangeRule): RangeBounds {
  const sample = rule.min ?? rule.max;
  if (typeof sample === 'number' || sample === undefined) {
    return {
      kind: 'number',
      low: typeof rule.min === 'number' ? rule.min : null,
      high: typeof rule.max === 'number' ? rule.max : null,
      highInclusive: true,
    };
  }
  const time = (bound: string) => Date.parse(DATE_ONLY.test(bound) ? `${bound}T00:00:00Z` : bound);
  const dayMax = typeof rule.max === 'string' && DATE_ONLY.test(rule.max);
  return {
    kind: 'time',
    low: typeof rule.min === 'string' ? time(rule.min) : null,
    high: typeof rule.max === 'string' ? time(rule.max) + (dayMax ? DAY_MS : 0) : null,
    highInclusive: !dayMax,
  };
}

/** The range kind of a normalized column type, or null when ranges do not
 * apply to it. */
export function rangeKind(type: string): RangeKind | null {
  if (type === 'integer' || type === 'decimal') return 'number';
  if (type === 'date' || type === 'timestamp') return 'time';
  return null;
}

/** One CSV cell as a comparable value; null when empty or unreadable.
 * Times without a zone are UTC, like PostgreSQL values (D-59). */
export function parseCsvValue(kind: RangeKind, raw: string): number | null {
  const value = raw.trim();
  if (value === '') return null;
  if (kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  let text = DATE_ONLY.test(value) ? `${value}T00:00:00` : value.replace(' ', 'T');
  // "+0530" to "+05:30", then UTC when no zone is given.
  text = text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** Counts values outside the bounds in one pass; keeps counts only. */
export class RangeCounter {
  private counts: RangeCounts = { valuesChecked: 0, belowMin: 0, aboveMax: 0 };

  constructor(private readonly bounds: RangeBounds) {}

  add(value: number): void {
    const { low, high, highInclusive } = this.bounds;
    this.counts.valuesChecked += 1;
    if (low !== null && value < low) this.counts.belowMin += 1;
    else if (high !== null && (highInclusive ? value > high : value >= high)) {
      this.counts.aboveMax += 1;
    }
  }

  result(): RangeCounts {
    return { ...this.counts };
  }
}

/** Range (D-63): passes when no value is outside the bounds. Empty values
 * are the not-null rule's concern and are not checked; with no value at
 * all the result is insufficient_data. Only counts are stored, never the
 * values themselves. */
export function evaluateRange(rule: RangeRule, counts: RangeCounts): CheckOutcome {
  const expected = { column: rule.column, min: rule.min ?? null, max: rule.max ?? null };
  if (counts.valuesChecked === 0) {
    return { status: 'insufficient_data', expected, actual: { ...counts, reason: 'no_values' } };
  }
  return {
    status: counts.belowMin + counts.aboveMax === 0 ? 'passed' : 'failed',
    expected,
    actual: { ...counts },
  };
}
