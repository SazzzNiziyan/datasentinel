import type { CheckRunSummary } from '@datasentinel/contracts';
import { describe, expect, it } from 'vitest';
import { describeRun } from '../../src/rules/describeRun.ts';
import { formatDuration } from '../../src/format.ts';

const run = (
  status: CheckRunSummary['status'],
  expected: Record<string, unknown> | null,
  actual: Record<string, unknown> | null,
): CheckRunSummary => ({
  id: 'c1',
  ruleVersion: 1,
  trigger: 'manual',
  status,
  expected,
  actual,
  error: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
});

describe('describeRun', () => {
  it('states measured values with units and limits', () => {
    expect(
      describeRun(
        'freshness',
        run('failed', { maxAgeMinutes: 60 }, { ageMinutes: 90, lastUpdatedAt: 'x' }),
      ),
    ).toBe('The newest data was 90 minutes old; the limit is 1 hour.');
    expect(
      describeRun(
        'not_null',
        run('failed', { maxNullPercent: 0 }, { rowCount: 4, nullCount: 1, nullPercent: 25 }),
      ),
    ).toBe('1 of 4 rows empty (25%); up to 0% allowed.');
    expect(
      describeRun(
        'row_count',
        run('passed', {}, { rowCount: 2_000_000, rowCountMethod: 'approximate' }),
      ),
    ).toBe('About 2,000,000 rows (database estimate).');
    expect(
      describeRun('range', run('failed', {}, { valuesChecked: 4, belowMin: 0, aboveMax: 1 })),
    ).toBe('0 below and 1 above the range, of 4 values checked.');
  });

  it('names the method and comparison window of a change against history', () => {
    expect(
      describeRun(
        'metric_change',
        run(
          'failed',
          { comparisonWindowDays: 7 },
          {
            current: 60,
            currentMethod: 'exact',
            baseline: 100,
            absoluteChange: -40,
            percentChange: -40,
            historyPoints: 3,
            windowStart: '2026-10-10T12:00:00.000Z',
            windowEnd: '2026-10-17T12:00:00.000Z',
          },
        ),
      ),
    ).toBe(
      '60 (exact count) against a median of 100 from 3 profiles, 10 Oct to 17 Oct: -40 (-40%).',
    );
  });

  it('lists schema problems and drift', () => {
    expect(
      describeRun(
        'schema',
        run(
          'failed',
          {},
          {
            missing: ['email'],
            wrongType: [{ name: 'id', expected: 'integer', actual: 'text' }],
            added: ['city'],
            removed: [],
            typeChanged: [],
          },
        ),
      ),
    ).toBe('Missing: email. id is text, not integer. Since the previous schema: added city.');
  });

  it('explains insufficient data and errors', () => {
    expect(
      describeRun(
        'metric_change',
        run(
          'insufficient_data',
          { minimumHistoryPoints: 5 },
          {
            reason: 'short_history',
            historyPoints: 2,
          },
        ),
      ),
    ).toBe('Only 2 earlier profiles in the comparison window; 5 needed.');
    expect(
      describeRun('row_count', {
        ...run('error', null, null),
        error: { code: 'timeout', message: 'The source took too long.', retryable: true },
      }),
    ).toBe('The source took too long.');
  });

  it('formats durations', () => {
    expect(formatDuration(120)).toBe('120 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});
