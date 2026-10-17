import type { RuleType } from '@datasentinel/contracts';

/** What the rule builder edits: text as typed, turned into a definition
 * by `buildDefinition` and validated by the shared schema (D-58). */
export type RuleForm = {
  type: RuleType;
  column: string;
  columns: string[];
  /** '' means the dataset's last update time. */
  timestampColumn: string;
  maxAge: string;
  ageUnit: 'minutes' | 'hours' | 'days';
  maxNullPercent: string;
  maxDuplicateRows: string;
  minRows: string;
  maxRows: string;
  min: string;
  max: string;
  /** Schema rules: also require each column's current type. */
  withTypes: boolean;
  metric: 'row_count' | 'null_count';
  comparisonWindowDays: '7' | '30';
  maxIncreasePercent: string;
  maxDropPercent: string;
  minimumHistoryPoints: string;
};

export const ruleTypeLabels: Record<RuleType, string> = {
  freshness: 'Freshness',
  not_null: 'Empty values',
  uniqueness: 'Duplicates',
  row_count: 'Row count',
  range: 'Value range',
  schema: 'Required columns',
  metric_change: 'Change against history',
};

export const emptyRuleForm = (): RuleForm => ({
  type: 'freshness',
  column: '',
  columns: [],
  timestampColumn: '',
  maxAge: '1',
  ageUnit: 'days',
  maxNullPercent: '0',
  maxDuplicateRows: '0',
  minRows: '',
  maxRows: '',
  min: '',
  max: '',
  withTypes: true,
  metric: 'row_count',
  comparisonWindowDays: '7',
  maxIncreasePercent: '',
  maxDropPercent: '30',
  minimumHistoryPoints: '5',
});

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;

/** Blank is "not set"; anything else must read as a number. */
const num = (text: string): number | undefined =>
  text.trim() === '' ? undefined : Number(text.trim());

const isTime = (type: string | undefined) => type === 'date' || type === 'timestamp';

/** The definition the form describes. It may be invalid; the schema says
 * why. Range bounds stay text for date columns, numbers otherwise. */
export function buildDefinition(
  form: RuleForm,
  columns: readonly { name: string; type: string }[],
): Record<string, unknown> {
  const base = { version: 1, type: form.type };
  switch (form.type) {
    case 'freshness': {
      const age = num(form.maxAge);
      return {
        ...base,
        ...(form.timestampColumn === '' ? {} : { timestampColumn: form.timestampColumn }),
        maxAgeMinutes: age === undefined ? undefined : age * UNIT_MINUTES[form.ageUnit],
      };
    }
    case 'not_null':
      return { ...base, column: form.column, maxNullPercent: num(form.maxNullPercent) };
    case 'uniqueness':
      return { ...base, columns: form.columns, maxDuplicateRows: num(form.maxDuplicateRows) };
    case 'row_count':
      return { ...base, minRows: num(form.minRows), maxRows: num(form.maxRows) };
    case 'range': {
      const time = isTime(columns.find((c) => c.name === form.column)?.type);
      const value = (text: string) =>
        text.trim() === '' ? undefined : time ? text.trim() : Number(text.trim());
      return { ...base, column: form.column, min: value(form.min), max: value(form.max) };
    }
    case 'schema':
      return {
        ...base,
        requiredColumns: form.columns.map((name) => {
          const type = columns.find((c) => c.name === name)?.type;
          return form.withTypes && type !== undefined && type !== 'unknown'
            ? { name, type }
            : { name };
        }),
      };
    case 'metric_change':
      return {
        ...base,
        metric: form.metric,
        ...(form.metric === 'null_count' ? { column: form.column } : {}),
        comparisonWindowDays: Number(form.comparisonWindowDays),
        maxIncreasePercent: num(form.maxIncreasePercent),
        maxDropPercent: num(form.maxDropPercent),
        minimumHistoryPoints: num(form.minimumHistoryPoints),
      };
  }
}

const fieldLabels: Record<string, string> = {
  maxAgeMinutes: 'Maximum age',
  timestampColumn: 'Timestamp column',
  column: 'Column',
  columns: 'Columns',
  maxNullPercent: 'Allowed empty values',
  maxDuplicateRows: 'Allowed repeated rows',
  minRows: 'Fewest rows',
  maxRows: 'Most rows',
  min: 'Lowest value',
  max: 'Highest value',
  requiredColumns: 'Required columns',
  maxIncreasePercent: 'Allowed rise',
  maxDropPercent: 'Allowed drop',
  minimumHistoryPoints: 'Earlier profiles needed',
};

/** Schema messages in the builder's words; others pass through. */
function friendly(message: string): string {
  if (/received (undefined|NaN)/.test(message)) return 'Enter a number.';
  if (/expected array to have >=1/.test(message)) return 'Choose at least one column.';
  const most = /expected array to have <=(\d+)/.exec(message);
  if (most) return `Choose at most ${most[1]} columns.`;
  if (/expected string to have >=1/.test(message)) return 'Choose a column.';
  if (/expected int/.test(message)) return 'Use a whole number.';
  const low = /expected number to be >=?(-?[\d.]+)/.exec(message);
  if (low && message.startsWith('Too small')) return `Use ${low[1]} or more.`;
  const high = /expected number to be <=?(-?[\d.]+)/.exec(message);
  if (high && message.startsWith('Too big')) return `Use ${high[1]} or less.`;
  if (message === 'Invalid input') return 'Use a number, or a date like 2026-01-31.';
  return message;
}

/** A validation problem in the builder's words: field, then what to do. */
export function problemText({ path, message }: { path: string; message: string }): string {
  const field = fieldLabels[path.split('.')[0] ?? ''] ?? 'Rule';
  return `${field}: ${friendly(message)}`;
}
