import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profileMetrics, readMeasurements } from '../src/jobs/profile-metrics.js';

const observedAt = new Date('2026-10-17T09:00:00.000Z');
const at = observedAt.toISOString();

describe('profile metrics', () => {
  it('records each metric with its method and observation time', () => {
    const metrics = profileMetrics({
      observedAt,
      rowCount: 3,
      rowCountMethod: 'exact',
      columns: [
        { name: 'id', type: 'integer', nullCount: 0 },
        { name: 'email', type: 'text', nullCount: 1 },
      ],
    });
    assert.equal(metrics.version, 1);
    assert.deepEqual(metrics.columns, [
      { name: 'id', type: 'integer', nullCount: 0 },
      { name: 'email', type: 'text', nullCount: 1 },
    ]);
    assert.deepEqual(readMeasurements(metrics), [
      { metric: 'row_count', column: null, value: 3, method: 'exact', observedAt: at },
      { metric: 'null_count', column: 'id', value: 0, method: 'exact', observedAt: at },
      { metric: 'null_count', column: 'email', value: 1, method: 'exact', observedAt: at },
    ]);
  });

  it('keeps an estimate marked approximate and skips metrics that were not counted', () => {
    const metrics = profileMetrics({
      observedAt,
      rowCount: 5_000_000,
      rowCountMethod: 'approximate',
      columns: [{ name: 'id', type: 'integer', nativeType: 'int4', nullCount: null }],
    });
    assert.deepEqual(readMeasurements(metrics), [
      {
        metric: 'row_count',
        column: null,
        value: 5_000_000,
        method: 'approximate',
        observedAt: at,
      },
    ]);
  });

  it('reads nothing from unversioned or malformed metrics', () => {
    assert.deepEqual(readMeasurements({ columns: [] }), []);
    assert.deepEqual(readMeasurements(null), []);
    assert.deepEqual(
      readMeasurements({
        version: 1,
        measurements: [
          { metric: 'row_count', value: 'x' },
          { metric: 'other', value: 1 },
        ],
      }),
      [],
    );
  });
});
