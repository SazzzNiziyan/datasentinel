import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HEALTHY_ROWS,
  SYNTHETIC_CASES,
  syntheticCsv,
  type SyntheticCase,
} from '../src/dev/synthetic-datasets.js';

const now = new Date('2026-10-18T12:00:00.000Z');

function parse(kind: SyntheticCase) {
  const [head, ...lines] = syntheticCsv(kind, now).trimEnd().split('\n');
  const header = (head ?? '').split(',');
  return { header, data: lines.map((l) => l.split(',')) };
}

describe('synthetic datasets', () => {
  it('healthy is complete, unique, and fresh', () => {
    const { header, data } = parse('healthy');
    assert.equal(data.length, HEALTHY_ROWS);
    assert.ok(data.every((r) => r.every((v) => v !== '')));
    assert.equal(new Set(data.map((r) => r[0])).size, HEALTHY_ROWS);
    const newest = Math.max(...data.map((r) => Date.parse(r[header.indexOf('updated_at')] ?? '')));
    assert.ok(now.getTime() - newest <= 10 * 60_000);
  });

  it('stale is old', () => {
    const { header, data } = parse('stale');
    const newest = Math.max(...data.map((r) => Date.parse(r[header.indexOf('updated_at')] ?? '')));
    assert.ok(now.getTime() - newest >= 48 * 60 * 60_000);
  });

  it('incomplete has missing values', () => {
    const { data } = parse('incomplete');
    assert.equal(data.filter((r) => r[1] === '').length, HEALTHY_ROWS / 4);
    assert.equal(data.filter((r) => r[2] === '').length, HEALTHY_ROWS / 10);
  });

  it('duplicate repeats five percent of ids', () => {
    const { data } = parse('duplicate');
    assert.equal(data.length - new Set(data.map((r) => r[0])).size, HEALTHY_ROWS / 20);
  });

  it('schema_drift loses the amount column', () => {
    assert.deepEqual(parse('schema_drift').header, [
      'order_id',
      'customer',
      'status',
      'updated_at',
    ]);
  });

  it('volume_drop has 60 percent fewer rows', () => {
    assert.equal(parse('volume_drop').data.length, HEALTHY_ROWS * 0.4);
  });

  it('contains no embedded commas that would break the simple format', () => {
    for (const kind of SYNTHETIC_CASES) {
      const { header, data } = parse(kind);
      assert.ok(
        data.every((r) => r.length === header.length),
        kind,
      );
    }
  });
});
