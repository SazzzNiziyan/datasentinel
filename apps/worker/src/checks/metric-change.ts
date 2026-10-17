import type { RuleDefinition } from '@datasentinel/contracts';
import type { Measurement } from '../jobs/profile-metrics.js';
import type { CheckOutcome } from './outcome.js';

type MetricChangeRule = Extract<RuleDefinition, { type: 'metric_change' }>;

const DAY_MS = 86_400_000;

/** The middle value; the mean of the middle pair for an even count. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The comparison window: the `comparisonWindowDays` before the current
 * measurement, excluding it. */
export function comparisonWindow(
  rule: MetricChangeRule,
  observedAt: Date,
): { start: Date; end: Date } {
  return {
    start: new Date(observedAt.getTime() - rule.comparisonWindowDays * DAY_MS),
    end: observedAt,
  };
}

/** Metric change (D-65, Q-05): compares the current measurement with the
 * median of the same metric in the window before it. Fewer history points
 * than `minimumHistoryPoints` is insufficient_data, never a pass. A limit
 * is checked only when set and is inclusive. From a zero baseline, any rise
 * is an unbounded increase (percentChange null) and no change is 0%. */
export function evaluateMetricChange(
  rule: MetricChangeRule,
  current: (Pick<Measurement, 'value' | 'method'> & { observedAt: Date }) | null,
  history: readonly number[],
): CheckOutcome {
  const expected = {
    metric: rule.metric,
    column: rule.column ?? null,
    comparisonWindowDays: rule.comparisonWindowDays,
    baseline: 'median',
    minimumHistoryPoints: rule.minimumHistoryPoints,
    maxIncreasePercent: rule.maxIncreasePercent ?? null,
    maxDropPercent: rule.maxDropPercent ?? null,
  };
  if (current === null) {
    return { status: 'insufficient_data', expected, actual: { reason: 'no_profile' } };
  }
  const window = comparisonWindow(rule, current.observedAt);
  const where = {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
  };
  if (history.length < rule.minimumHistoryPoints) {
    return {
      status: 'insufficient_data',
      expected,
      actual: { reason: 'short_history', historyPoints: history.length, ...where },
    };
  }
  const baseline = median(history);
  const change = current.value - baseline;
  const percent = baseline === 0 ? (change === 0 ? 0 : null) : (change / Math.abs(baseline)) * 100;
  const rise = percent ?? Number.POSITIVE_INFINITY;
  const tooHigh = rule.maxIncreasePercent !== undefined && rise > rule.maxIncreasePercent;
  const tooLow = rule.maxDropPercent !== undefined && -rise > rule.maxDropPercent;
  return {
    status: tooHigh || tooLow ? 'failed' : 'passed',
    expected,
    actual: {
      current: current.value,
      currentMethod: current.method,
      baseline,
      absoluteChange: change,
      percentChange: percent === null ? null : Math.round(percent * 100) / 100,
      historyPoints: history.length,
      ...where,
    },
  };
}
