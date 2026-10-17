import type { CheckRunSummary, RuleType } from '@datasentinel/contracts';
import { formatCount, formatDay } from '../format.ts';
import { formatMinutes } from './describeRule.ts';

type Values = Record<string, unknown>;

const n = (v: unknown) => (typeof v === 'number' ? formatCount(v) : '?');
const signed = (v: unknown) => (typeof v === 'number' && v > 0 ? `+${n(v)}` : n(v));
const profiles = (v: unknown) => `${n(v)} ${v === 1 ? 'profile' : 'profiles'}`;
const names = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(', ') : '');

function insufficient(a: Values, e: Values): string {
  switch (a.reason) {
    case 'short_history':
      return `Only ${n(a.historyPoints)} earlier ${a.historyPoints === 1 ? 'profile' : 'profiles'} in the comparison window; ${n(e.minimumHistoryPoints)} needed.`;
    case 'no_profile':
      return 'There is no successful profile to check yet.';
    case 'no_rows':
      return 'The dataset has no rows to check.';
    case 'no_values':
      return 'The column has no values to check.';
    default:
      return 'There was not enough data to decide.';
  }
}

function schema(a: Values): string {
  const parts: string[] = [];
  if (names(a.missing) !== '') parts.push(`Missing: ${names(a.missing)}.`);
  for (const w of (a.wrongType as { name: string; expected: string; actual: string }[]) ?? []) {
    parts.push(`${w.name} is ${w.actual}, not ${w.expected}.`);
  }
  const drift = [
    names(a.added) === '' ? null : `added ${names(a.added)}`,
    names(a.removed) === '' ? null : `removed ${names(a.removed)}`,
    ...((a.typeChanged as { name: string; from: string; to: string }[]) ?? []).map(
      (c) => `${c.name} changed from ${c.from} to ${c.to}`,
    ),
  ].filter((d) => d !== null);
  if (drift.length > 0) parts.push(`Since the previous schema: ${drift.join('; ')}.`);
  return parts.length === 0 ? 'Every required column is present with its type.' : parts.join(' ');
}

/** What one check run measured, with units, method, and window (D-68).
 * Built from the stored expected/actual values, never from row samples. */
export function describeRun(type: RuleType, run: CheckRunSummary): string {
  if (run.status === 'queued' || run.status === 'running') return 'Waiting for the result.';
  if (run.status === 'error') return run.error?.message ?? 'The check could not run.';
  const a: Values = run.actual ?? {};
  const e: Values = run.expected ?? {};
  if (run.status === 'insufficient_data') return insufficient(a, e);
  switch (type) {
    case 'freshness':
      return typeof a.ageMinutes === 'number'
        ? `The newest data was ${formatMinutes(a.ageMinutes)} old; the limit is ${formatMinutes(Number(e.maxAgeMinutes))}.`
        : 'No timestamp was found, so the data counts as stale.';
    case 'not_null':
      return `${n(a.nullCount)} of ${n(a.rowCount)} rows empty (${n(a.nullPercent)}%); up to ${n(e.maxNullPercent)}% allowed.`;
    case 'uniqueness':
      return `${n(a.duplicateRows)} repeated rows across ${n(a.duplicateKeys)} keys, of ${n(a.rowCount)} rows; up to ${n(e.maxDuplicateRows)} allowed.`;
    case 'row_count':
      return a.rowCountMethod === 'approximate'
        ? `About ${n(a.rowCount)} rows (database estimate).`
        : `${n(a.rowCount)} rows (exact count).`;
    case 'range':
      return `${n(a.belowMin)} below and ${n(a.aboveMax)} above the range, of ${n(a.valuesChecked)} values checked.`;
    case 'schema':
      return schema(a);
    case 'metric_change': {
      const method = a.currentMethod === 'approximate' ? 'database estimate' : 'exact count';
      const window =
        typeof a.windowStart === 'string' && typeof a.windowEnd === 'string'
          ? `${formatDay(a.windowStart)} to ${formatDay(a.windowEnd)}`
          : `the previous ${n(e.comparisonWindowDays)} days`;
      const change =
        a.percentChange === null
          ? `${signed(a.absoluteChange)} (a rise from zero)`
          : `${signed(a.absoluteChange)} (${signed(a.percentChange)}%)`;
      return `${n(a.current)} (${method}) against a median of ${n(a.baseline)} from ${profiles(a.historyPoints)}, ${window}: ${change}.`;
    }
  }
}
