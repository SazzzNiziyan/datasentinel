/** Synthetic CSV datasets for demos and the staging walkthrough (Phase N).
 * All values are invented. Each case differs from `healthy` in one way that a
 * rule should catch: stale timestamps, missing values, duplicate keys, a
 * dropped column (schema drift), or a 60% drop in row count. */

export type SyntheticCase =
  'healthy' | 'stale' | 'incomplete' | 'duplicate' | 'schema_drift' | 'volume_drop';

export const SYNTHETIC_CASES: readonly SyntheticCase[] = [
  'healthy',
  'stale',
  'incomplete',
  'duplicate',
  'schema_drift',
  'volume_drop',
];

export const HEALTHY_ROWS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  order_id: number;
  customer: string;
  amount: number;
  status: string;
  updated_at: string;
}

function rows(count: number, now: Date, newestAgeMs: number): Row[] {
  const statuses = ['paid', 'shipped', 'refunded'];
  return Array.from({ length: count }, (_, i) => ({
    order_id: i + 1,
    customer: `customer-${(i * 7) % 250}`,
    amount: 10 + ((i * 13) % 490),
    status: statuses[i % statuses.length] ?? 'paid',
    // The newest row is newestAgeMs old; earlier rows are a minute apart.
    updated_at: new Date(now.getTime() - newestAgeMs - (count - 1 - i) * 60_000).toISOString(),
  }));
}

function toCsv(header: string[], data: (string | number)[][]): string {
  return [header.join(','), ...data.map((r) => r.join(','))].join('\n') + '\n';
}

const columns = ['order_id', 'customer', 'amount', 'status', 'updated_at'] as const;

/** The CSV text of one case, generated relative to `now`. */
export function syntheticCsv(kind: SyntheticCase, now = new Date()): string {
  const fresh = 5 * 60_000;
  const toLine = (r: Row, skip: readonly string[] = []) =>
    columns.filter((c) => !skip.includes(c)).map((c) => r[c]);
  const header = (skip: readonly string[] = []) => columns.filter((c) => !skip.includes(c));

  switch (kind) {
    case 'healthy':
      return toCsv(
        header(),
        rows(HEALTHY_ROWS, now, fresh).map((r) => toLine(r)),
      );
    case 'stale':
      return toCsv(
        header(),
        rows(HEALTHY_ROWS, now, 3 * DAY_MS).map((r) => toLine(r)),
      );
    case 'incomplete':
      // Every fourth customer and every tenth amount is missing.
      return toCsv(
        header(),
        rows(HEALTHY_ROWS, now, fresh).map((r) => {
          const line = toLine(r);
          if (r.order_id % 4 === 0) line[1] = '';
          if (r.order_id % 10 === 0) line[2] = '';
          return line;
        }),
      );
    case 'duplicate':
      // 5% of order ids repeat an earlier id.
      return toCsv(
        header(),
        rows(HEALTHY_ROWS, now, fresh).map((r) => {
          const line = toLine(r);
          if (r.order_id % 20 === 0) line[0] = r.order_id - 1;
          return line;
        }),
      );
    case 'schema_drift':
      // The amount column disappears.
      return toCsv(
        header(['amount']),
        rows(HEALTHY_ROWS, now, fresh).map((r) => toLine(r, ['amount'])),
      );
    case 'volume_drop':
      // 60% fewer rows than the healthy day.
      return toCsv(
        header(),
        rows(Math.round(HEALTHY_ROWS * 0.4), now, fresh).map((r) => toLine(r)),
      );
  }
}
