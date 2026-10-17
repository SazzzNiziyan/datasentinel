import { describe, expect, it } from 'vitest';
import { describeRule, formatMinutes } from '../../src/rules/describeRule.ts';

describe('describeRule', () => {
  it('formats ages in the largest whole unit', () => {
    expect(formatMinutes(1)).toBe('1 minute');
    expect(formatMinutes(90)).toBe('90 minutes');
    expect(formatMinutes(120)).toBe('2 hours');
    expect(formatMinutes(1440)).toBe('1 day');
    expect(formatMinutes(2880)).toBe('2 days');
  });

  it('describes freshness with and without a timestamp column', () => {
    expect(describeRule({ version: 1, type: 'freshness', maxAgeMinutes: 1440 })).toBe(
      'Fails when the dataset was last updated more than 1 day ago.',
    );
    expect(
      describeRule({
        version: 1,
        type: 'freshness',
        timestampColumn: 'updated_at',
        maxAgeMinutes: 60,
      }),
    ).toBe('Fails when the newest updated_at is more than 1 hour old.');
  });

  it('describes empty values, duplicates, and row counts', () => {
    expect(describeRule({ version: 1, type: 'not_null', column: 'email', maxNullPercent: 0 })).toBe(
      'Fails when any email value is empty.',
    );
    expect(
      describeRule({ version: 1, type: 'not_null', column: 'email', maxNullPercent: 2.5 }),
    ).toBe('Fails when more than 2.5% of email values are empty.');
    expect(
      describeRule({ version: 1, type: 'uniqueness', columns: ['id'], maxDuplicateRows: 0 }),
    ).toBe('Fails when any id value appears more than once.');
    expect(
      describeRule({
        version: 1,
        type: 'uniqueness',
        columns: ['order_id', 'line'],
        maxDuplicateRows: 10,
      }),
    ).toBe('Fails when more than 10 rows repeat the combination of order_id and line.');
    expect(describeRule({ version: 1, type: 'row_count', minRows: 1000, maxRows: 5000 })).toBe(
      'Fails when the dataset has fewer than 1,000 or more than 5,000 rows.',
    );
    expect(describeRule({ version: 1, type: 'row_count', minRows: 1 })).toBe(
      'Fails when the dataset has fewer than 1 row.',
    );
  });

  it('describes ranges, schemas, and changes against history', () => {
    expect(describeRule({ version: 1, type: 'range', column: 'age', min: 0, max: 130 })).toBe(
      'Fails when any age value is below 0 or above 130.',
    );
    expect(describeRule({ version: 1, type: 'range', column: 'day', max: '2026-12-31' })).toBe(
      'Fails when any day value is after 2026-12-31.',
    );
    expect(
      describeRule({
        version: 1,
        type: 'schema',
        requiredColumns: [{ name: 'id', type: 'integer' }, { name: 'note' }],
      }),
    ).toBe('Fails when id (integer) or note is missing, or a listed type changes.');
    expect(
      describeRule({
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        comparisonWindowDays: 7,
        maxDropPercent: 30,
        minimumHistoryPoints: 5,
      }),
    ).toBe(
      'Fails when the row count drops more than 30% below the median of the previous 7 days. Needs at least 5 earlier profiles.',
    );
    expect(
      describeRule({
        version: 1,
        type: 'metric_change',
        metric: 'null_count',
        column: 'email',
        comparisonWindowDays: 30,
        maxIncreasePercent: 50,
        maxDropPercent: 20,
        minimumHistoryPoints: 5,
      }),
    ).toBe(
      'Fails when the empty email values rise more than 50% or drop more than 20% against the median of the previous 30 days. Needs at least 5 earlier profiles.',
    );
  });
});
