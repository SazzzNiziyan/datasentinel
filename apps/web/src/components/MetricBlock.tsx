import { StatusMark } from './StatusMark.tsx';
import './MetricBlock.css';

/** At least one bound is required: `{}` would describe no expectation. */
export type Expected = { min: number; max?: number } | { min?: number; max: number };

interface MetricBlockProps {
  label: string;
  value: number;
  unit?: string;
  expected?: Expected;
  /** The comparison window, e.g. "Last 24 hours". */
  window?: string;
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function withUnit(value: number, unit: string | undefined): string {
  if (unit === undefined) return number.format(value);
  // "12%" but "3 hours": percent is written without a space.
  return unit === '%' ? `${number.format(value)}%` : `${number.format(value)} ${unit}`;
}

/** Guards untyped data (e.g. API responses) that type-checking cannot. */
function hasBounds(expected: Expected | undefined): expected is Expected {
  return expected !== undefined && (expected.min !== undefined || expected.max !== undefined);
}

function describeExpected({ min, max }: Expected, unit?: string): string {
  if (min !== undefined && max !== undefined) {
    return `Expected between ${withUnit(min, unit)} and ${withUnit(max, unit)}`;
  }
  if (min !== undefined) return `Expected at least ${withUnit(min, unit)}`;
  return `Expected at most ${withUnit(max ?? 0, unit)}`;
}

/** How far outside the expected range the value is, or undefined if inside. */
function describeGap(value: number, { min, max }: Expected, unit?: string): string | undefined {
  const [gap, bound, direction] =
    min !== undefined && value < min
      ? [min - value, min, 'below']
      : max !== undefined && value > max
        ? [value - max, max, 'above']
        : [undefined, undefined, undefined];
  if (gap === undefined) return undefined;
  const percent = bound === 0 ? '' : ` (${Math.round((gap / Math.abs(bound)) * 100)}%)`;
  return `${withUnit(gap, unit)} ${direction} expected${percent}`;
}

/** One measured value, and when an expectation exists, the comparison that
 * explains a failure: "2,140 rows; expected at least 7,000; 4,860 below". */
export function MetricBlock({ label, value, unit, expected, window }: MetricBlockProps) {
  const bounded = hasBounds(expected);
  const gap = bounded ? describeGap(value, expected, unit) : undefined;
  return (
    <div className="metric-block">
      <p className="metric-block__label">{label}</p>
      <p className="metric-block__value">
        <span>{number.format(value)}</span>
        {unit !== undefined && <span className="metric-block__unit">{unit}</span>}
      </p>
      {bounded && (
        <div className="metric-block__comparison">
          <p>{describeExpected(expected, unit)}</p>
          {gap !== undefined && <p className="metric-block__gap">{gap}</p>}
          <StatusMark
            tone={gap === undefined ? 'healthy' : 'critical'}
            label={gap === undefined ? 'Within expected range' : 'Outside expected range'}
          />
        </div>
      )}
      {window !== undefined && <p className="metric-block__window">{window}</p>}
    </div>
  );
}
