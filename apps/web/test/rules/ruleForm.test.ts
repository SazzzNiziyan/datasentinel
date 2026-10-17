import { validateRuleDefinition } from '@datasentinel/contracts';
import { describe, expect, it } from 'vitest';
import { buildDefinition, emptyRuleForm, problemText } from '../../src/rules/ruleForm.ts';

const columns = [
  { name: 'id', type: 'integer' },
  { name: 'shipped_on', type: 'date' },
  { name: 'note', type: 'unknown' },
];

describe('rule form', () => {
  it('turns a freshness age and unit into minutes', () => {
    const form = { ...emptyRuleForm(), maxAge: '2', ageUnit: 'hours' as const };
    expect(buildDefinition(form, columns)).toEqual({
      version: 1,
      type: 'freshness',
      maxAgeMinutes: 120,
    });
  });

  it('keeps date bounds as text and number bounds as numbers', () => {
    const dates = {
      ...emptyRuleForm(),
      type: 'range' as const,
      column: 'shipped_on',
      max: '2026-01-31',
    };
    expect(buildDefinition(dates, columns)).toMatchObject({ max: '2026-01-31', min: undefined });
    const numbers = { ...emptyRuleForm(), type: 'range' as const, column: 'id', min: '0' };
    expect(buildDefinition(numbers, columns)).toMatchObject({ min: 0 });
  });

  it('adds current types to required columns unless the type is unknown', () => {
    const form = { ...emptyRuleForm(), type: 'schema' as const, columns: ['id', 'note'] };
    expect(buildDefinition(form, columns)).toEqual({
      version: 1,
      type: 'schema',
      requiredColumns: [{ name: 'id', type: 'integer' }, { name: 'note' }],
    });
  });

  it('words schema problems as what to do next', () => {
    const problems = (input: Record<string, unknown>) => {
      const result = validateRuleDefinition(input);
      return result.ok ? [] : result.problems.map(problemText);
    };
    expect(problems({ version: 1, type: 'not_null', column: '', maxNullPercent: 0 })).toEqual([
      'Column: Choose a column.',
    ]);
    expect(problems({ version: 1, type: 'freshness', maxAgeMinutes: undefined })).toEqual([
      'Maximum age: Enter a number.',
    ]);
    expect(problems({ version: 1, type: 'freshness', maxAgeMinutes: 1.5 })).toEqual([
      'Maximum age: Use a whole number.',
    ]);
    expect(
      problems({ version: 1, type: 'uniqueness', columns: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toEqual(['Columns: Choose at most 5 columns.']);
    expect(problems({ version: 1, type: 'not_null', column: 'a', maxNullPercent: 120 })).toEqual([
      'Allowed empty values: Use 100 or less.',
    ]);
  });
});
