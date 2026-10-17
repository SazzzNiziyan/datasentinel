import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffSchemas, readSchemaColumns } from '../src/jobs/schema-diff.js';

const col = (name: string, type: string, nullable = false) => ({ name, type, nullable });

describe('schema comparison', () => {
  it('reports added, removed, and type-changed fields', () => {
    const diff = diffSchemas(
      [col('id', 'integer'), col('email', 'text'), col('age', 'integer'), col('gone', 'text')],
      [col('id', 'integer'), col('age', 'decimal'), col('email', 'text'), col('city', 'text')],
    );
    assert.deepEqual(diff, {
      changed: true,
      added: [{ name: 'city', type: 'text' }],
      removed: [{ name: 'gone', type: 'text' }],
      typeChanged: [{ name: 'age', from: 'integer', to: 'decimal' }],
    });
  });

  it('ignores column order and reports no change for equal schemas', () => {
    const diff = diffSchemas(
      [col('a', 'text'), col('b', 'integer')],
      [col('b', 'integer'), col('a', 'text')],
    );
    assert.deepEqual(diff, { changed: false, added: [], removed: [], typeChanged: [] });
  });

  it('treats names as case-sensitive', () => {
    const diff = diffSchemas([col('Email', 'text')], [col('email', 'text')]);
    assert.deepEqual(diff.added, [{ name: 'email', type: 'text' }]);
    assert.deepEqual(diff.removed, [{ name: 'Email', type: 'text' }]);
  });

  it('reads stored snapshot columns and rejects malformed ones', () => {
    assert.deepEqual(
      readSchemaColumns([{ name: 'id', type: 'integer', nullable: false, ordinal: 1 }]),
      [col('id', 'integer')],
    );
    assert.equal(readSchemaColumns([{ name: 'id' }]), null);
    assert.equal(readSchemaColumns({}), null);
  });
});
