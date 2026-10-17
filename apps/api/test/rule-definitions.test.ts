import { validateRuleDefinition } from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ok = (input: unknown) => {
  const result = validateRuleDefinition(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.definition : undefined;
};
const problems = (input: unknown) => {
  const result = validateRuleDefinition(input);
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be refused`);
  return result.ok ? [] : result.problems;
};

describe('rule definitions', () => {
  it('accepts one valid definition of every rule type', () => {
    const valid = [
      { version: 1, type: 'freshness', maxAgeMinutes: 1440 },
      { version: 1, type: 'freshness', timestampColumn: 'updated_at', maxAgeMinutes: 60 },
      { version: 1, type: 'not_null', column: 'customer_id', maxNullPercent: 0 },
      { version: 1, type: 'uniqueness', columns: ['id'] },
      { version: 1, type: 'row_count', minRows: 1 },
      { version: 1, type: 'row_count', minRows: 10, maxRows: 10 },
      { version: 1, type: 'range', column: 'age', min: 0, max: 130 },
      { version: 1, type: 'range', column: 'shipped_on', min: '2020-01-01' },
      {
        version: 1,
        type: 'schema',
        requiredColumns: [{ name: 'id', type: 'integer' }, { name: 'note' }],
      },
      {
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        comparisonWindowDays: 7,
        maxDropPercent: 30,
      },
      {
        version: 1,
        type: 'metric_change',
        metric: 'null_count',
        column: 'email',
        comparisonWindowDays: 30,
        maxIncreasePercent: 50,
        minimumHistoryPoints: 10,
      },
    ];
    for (const input of valid) ok(input);
  });

  it('fills documented defaults', () => {
    assert.deepEqual(ok({ version: 1, type: 'uniqueness', columns: ['id'] }), {
      version: 1,
      type: 'uniqueness',
      columns: ['id'],
      maxDuplicateRows: 0,
    });
    assert.equal(
      (
        ok({
          version: 1,
          type: 'metric_change',
          metric: 'row_count',
          comparisonWindowDays: 7,
          maxDropPercent: 1,
        }) as {
          minimumHistoryPoints: number;
        }
      ).minimumHistoryPoints,
      5,
    );
  });

  it('refuses unknown versions, types, and fields', () => {
    assert.deepEqual(problems({ version: 2, type: 'freshness', maxAgeMinutes: 60 }), [
      { path: 'version', message: 'This rule version is not supported.' },
    ]);
    assert.equal(
      problems({ version: 1, type: 'custom_sql', sql: 'DROP TABLE x' })[0]?.path,
      'type',
    );
    assert.equal(
      problems({ version: 1, type: 'not_null', column: 'a', maxNullPercent: 0, sql: 'x' }).length,
      1,
    );
    assert.equal(problems(null).length, 1);
    assert.equal(problems('freshness').length, 1);
  });

  it('refuses out-of-range and contradictory settings', () => {
    const refused = [
      { version: 1, type: 'freshness', maxAgeMinutes: 0 },
      { version: 1, type: 'freshness', maxAgeMinutes: 1.5 },
      { version: 1, type: 'not_null', column: 'a', maxNullPercent: 101 },
      { version: 1, type: 'not_null', column: '', maxNullPercent: 0 },
      { version: 1, type: 'uniqueness', columns: [] },
      { version: 1, type: 'uniqueness', columns: ['a', 'a'] },
      { version: 1, type: 'row_count' },
      { version: 1, type: 'row_count', minRows: 5, maxRows: 4 },
      { version: 1, type: 'range', column: 'a' },
      { version: 1, type: 'range', column: 'a', min: 5, max: 1 },
      { version: 1, type: 'range', column: 'a', min: 1, max: '2020-01-01' },
      { version: 1, type: 'range', column: 'a', min: '2020-13-45' },
      { version: 1, type: 'schema', requiredColumns: [] },
      { version: 1, type: 'schema', requiredColumns: [{ name: 'a' }, { name: 'a' }] },
      {
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        comparisonWindowDays: 14,
        maxDropPercent: 1,
      },
      { version: 1, type: 'metric_change', metric: 'row_count', comparisonWindowDays: 7 },
      {
        version: 1,
        type: 'metric_change',
        metric: 'null_count',
        comparisonWindowDays: 7,
        maxDropPercent: 1,
      },
      {
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        column: 'a',
        comparisonWindowDays: 7,
        maxDropPercent: 1,
      },
      {
        version: 1,
        type: 'metric_change',
        metric: 'row_count',
        comparisonWindowDays: 7,
        maxDropPercent: 1,
        minimumHistoryPoints: 2,
      },
    ];
    for (const input of refused) assert.ok(problems(input).length > 0);
  });

  it('describes problems by field path without echoing the input', () => {
    const [problem] = problems({ version: 1, type: 'row_count', minRows: 5, maxRows: 4 });
    assert.deepEqual(problem, {
      path: 'maxRows',
      message: 'The maximum must not be below the minimum.',
    });
  });
});
