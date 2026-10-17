import {
  correlatePipelineRuns,
  CORRELATION_AFTER_MS,
  CORRELATION_BEFORE_MS,
  type CorrelationCandidate,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const DATASET = 'd0000000-0000-4000-8000-000000000001';
const AT = new Date('2026-10-17T12:00:00.000Z');
const min = (n: number) => new Date(AT.getTime() + n * 60_000);

const run = (id: string, over: Partial<CorrelationCandidate> = {}): CorrelationCandidate => ({
  id,
  datasetId: null,
  correlationId: DATASET,
  startedAt: min(-60),
  endedAt: min(-30),
  lastEventAt: min(-30),
  ...over,
});

const ids = (runs: readonly CorrelationCandidate[]) =>
  correlatePipelineRuns({ datasetId: DATASET, at: AT }, runs).map((c) => c.run.id);

describe('pipeline run correlation', () => {
  it('matches only runs linked to the dataset, however close in time', () => {
    assert.deepEqual(
      ids([
        run('linked'),
        run('other-dataset', { correlationId: 'someone-else', datasetId: 'd2' }),
        run('unlinked-and-close', { correlationId: null, datasetId: null }),
      ]),
      ['linked'],
    );
  });

  it('reports which rule matched and how far away the run was', () => {
    const [first, second] = correlatePipelineRuns({ datasetId: DATASET, at: AT }, [
      run('by-correlation', { endedAt: min(-30) }),
      run('by-dataset', {
        datasetId: DATASET,
        correlationId: null,
        endedAt: min(-90),
        startedAt: min(-120),
        lastEventAt: min(-90),
      }),
    ]);
    assert.equal(first?.run.id, 'by-dataset');
    assert.equal(first?.reason, 'dataset_id');
    assert.equal(first?.distanceMinutes, 90);
    assert.equal(second?.reason, 'correlation_id');
    assert.equal(second?.distanceMinutes, 30);
  });

  it('keeps the window: 6 hours before to 30 minutes after the check', () => {
    const before = (end: number) =>
      run('r', { startedAt: min(end - 10), endedAt: min(end), lastEventAt: min(end) });
    assert.deepEqual(ids([before(-360)]), ['r']);
    assert.deepEqual(ids([before(-361)]), []);
    const start = (s: number) =>
      run('r', { startedAt: min(s), endedAt: min(s + 5), lastEventAt: min(s + 5) });
    assert.deepEqual(ids([start(30)]), ['r']);
    assert.deepEqual(ids([start(31)]), []);
    assert.equal(CORRELATION_BEFORE_MS, 360 * 60_000);
    assert.equal(CORRELATION_AFTER_MS, 30 * 60_000);
  });

  it('counts a run active during the check as distance 0', () => {
    const [c] = correlatePipelineRuns({ datasetId: DATASET, at: AT }, [
      run('active', { startedAt: min(-20), endedAt: min(20), lastEventAt: min(20) }),
    ]);
    assert.equal(c?.distanceMinutes, 0);
  });

  it('handles runs with missing times and returns at most five, closest first', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      run(`r${i}`, { startedAt: null, endedAt: null, lastEventAt: min(-10 * (i + 1)) }),
    );
    assert.deepEqual(ids(many), ['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});
