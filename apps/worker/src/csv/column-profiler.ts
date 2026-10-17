/** Normalized types a CSV column can be inferred as (D-43). "unknown"
 * means every value was empty, so nothing could be observed. */
export type CsvColumnType =
  'boolean' | 'integer' | 'decimal' | 'date' | 'timestamp' | 'text' | 'unknown';

const validDate = (y: string, m: string, d: string) => {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i;

/** Most specific first: a column takes the first type all its values fit. */
const checks: [CsvColumnType, (value: string) => boolean][] = [
  ['boolean', (v) => /^(?:true|false)$/i.test(v)],
  ['integer', (v) => /^[+-]?\d+$/.test(v)],
  ['decimal', (v) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)],
  [
    'date',
    (v) => {
      const m = DATE.exec(v);
      return m !== null && validDate(m[1]!, m[2]!, m[3]!);
    },
  ],
  [
    'timestamp',
    (v) => {
      const m = TIMESTAMP.exec(v);
      return m !== null && validDate(m[1]!, m[2]!, m[3]!);
    },
  ],
];

/** Watches one column's values as they stream past. Keeps only counts and
 * the types still possible, never the values themselves. */
export class ColumnProfiler {
  nullCount = 0;
  private observed = false;
  private readonly possible = new Set(checks.map(([type]) => type));

  /** Empty or blank values count as nulls. */
  add(raw: string): void {
    const value = raw.trim();
    if (value === '') {
      this.nullCount += 1;
      return;
    }
    this.observed = true;
    for (const [type, fits] of checks) {
      if (this.possible.has(type) && !fits(value)) this.possible.delete(type);
    }
  }

  get type(): CsvColumnType {
    if (!this.observed) return 'unknown';
    return checks.find(([type]) => this.possible.has(type))?.[0] ?? 'text';
  }
}
