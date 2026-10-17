import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateSchema } from '../src/checks/schema-rule.js';

const col = (name: string, type: string) => ({ name, type, nullable: true });
const rule = (requiredColumns: { name: string; type?: string }[]) => ({
  version: 1 as const,
  type: 'schema' as const,
  requiredColumns,
});

describe('schema rule', () => {
  it('passes when every required column exists with its type', () => {
    const result = evaluateSchema(
      rule([{ name: 'id', type: 'integer' }, { name: 'note' }]),
      [col('id', 'integer'), col('note', 'text')],
      null,
    );
    assert.deepEqual(result, {
      status: 'passed',
      expected: {
        requiredColumns: [
          { name: 'id', type: 'integer' },
          { name: 'note', type: null },
        ],
      },
      actual: { missing: [], wrongType: [], added: [], removed: [], typeChanged: [] },
    });
  });

  it('names missing columns and wrong types, case-sensitively', () => {
    const result = evaluateSchema(
      rule([{ name: 'Email' }, { name: 'age', type: 'integer' }]),
      [col('email', 'text'), col('age', 'decimal')],
      null,
    );
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.actual.missing, ['Email']);
    assert.deepEqual(result.actual.wrongType, [
      { name: 'age', expected: 'integer', actual: 'decimal' },
    ]);
  });

  it('reports drift against the previous schema by column name', () => {
    const result = evaluateSchema(
      rule([{ name: 'id' }]),
      [col('id', 'text'), col('city', 'text')],
      [col('id', 'integer'), col('zip', 'text')],
    );
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.actual.added, ['city']);
    assert.deepEqual(result.actual.removed, ['zip']);
    assert.deepEqual(result.actual.typeChanged, [{ name: 'id', from: 'integer', to: 'text' }]);
  });
});
