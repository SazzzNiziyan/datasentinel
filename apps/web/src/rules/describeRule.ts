import type { RuleDefinition } from '@datasentinel/contracts';

const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** 90 → "90 minutes", 120 → "2 hours", 2880 → "2 days". */
export function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

const list = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const either = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

const bound = (value: number | string) => (typeof value === 'number' ? count(value) : value);

/** The rule's condition in one plain sentence (FR-05), as shown in the
 * builder preview and on rule lists. */
export function describeRule(rule: RuleDefinition): string {
  switch (rule.type) {
    case 'freshness':
      return rule.timestampColumn === undefined
        ? `Fails when the dataset was last updated more than ${formatMinutes(rule.maxAgeMinutes)} ago.`
        : `Fails when the newest ${rule.timestampColumn} is more than ${formatMinutes(rule.maxAgeMinutes)} old.`;
    case 'not_null':
      return rule.maxNullPercent === 0
        ? `Fails when any ${rule.column} value is empty.`
        : `Fails when more than ${rule.maxNullPercent}% of ${rule.column} values are empty.`;
    case 'uniqueness': {
      const key =
        rule.columns.length === 1
          ? `${rule.columns[0]} value`
          : `combination of ${list(rule.columns)}`;
      return rule.maxDuplicateRows === 0
        ? `Fails when any ${key} appears more than once.`
        : `Fails when more than ${plural(rule.maxDuplicateRows, 'row')} repeat the ${key}.`;
    }
    case 'row_count': {
      const parts = [
        rule.minRows === undefined ? null : `fewer than ${plural(rule.minRows, 'row')}`,
        rule.maxRows === undefined ? null : `more than ${plural(rule.maxRows, 'row')}`,
      ].filter((p) => p !== null);
      // "fewer than 1,000 rows or more than 5,000 rows" reads better once.
      const text =
        parts.length === 2
          ? `fewer than ${count(rule.minRows ?? 0)} or more than ${plural(rule.maxRows ?? 0, 'row')}`
          : parts[0];
      return `Fails when the dataset has ${text}.`;
    }
    case 'range': {
      const dates = typeof (rule.min ?? rule.max) === 'string';
      const parts = [
        rule.min === undefined ? null : `${dates ? 'before' : 'below'} ${bound(rule.min)}`,
        rule.max === undefined ? null : `${dates ? 'after' : 'above'} ${bound(rule.max)}`,
      ].filter((p) => p !== null);
      return `Fails when any ${rule.column} value is ${parts.join(' or ')}.`;
    }
    case 'schema': {
      const names = rule.requiredColumns.map((c) =>
        c.type === undefined ? c.name : `${c.name} (${c.type})`,
      );
      const typed = rule.requiredColumns.some((c) => c.type !== undefined);
      return `Fails when ${either(names)} is missing${typed ? ', or a listed type changes' : ''}.`;
    }
    case 'metric_change': {
      const what =
        rule.metric === 'row_count' ? 'the row count' : `the empty ${rule.column ?? ''} values`;
      const verbs = rule.metric === 'row_count' ? ['rises', 'drops'] : ['rise', 'drop'];
      const limits = [
        rule.maxIncreasePercent === undefined
          ? null
          : `${verbs[0]} more than ${rule.maxIncreasePercent}%`,
        rule.maxDropPercent === undefined ? null : `${verbs[1]} more than ${rule.maxDropPercent}%`,
      ].filter((p) => p !== null);
      const against =
        limits.length === 1 && rule.maxDropPercent !== undefined
          ? `below the median of the previous ${rule.comparisonWindowDays} days`
          : `against the median of the previous ${rule.comparisonWindowDays} days`;
      return `Fails when ${what} ${limits.join(' or ')} ${against}. Needs at least ${rule.minimumHistoryPoints} earlier profiles.`;
    }
  }
}
