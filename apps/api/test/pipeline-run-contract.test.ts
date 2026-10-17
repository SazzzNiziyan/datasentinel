import {
  canMoveRun,
  checkEventTime,
  parseIntegrationToken,
  PipelineRunEvent,
  redactRunSummary,
  RUN_SUMMARY_MAX,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const secret = 'A'.repeat(43);
const hex = '0192f3a4b5c67d8e9f0a1b2c3d4e5f60';

describe('pipeline-run event contract', () => {
  it('reads a bearer integration token and nothing else', () => {
    assert.deepEqual(parseIntegrationToken(`Bearer dsp_${hex}_${secret}`), {
      tokenId: '0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60',
      secret,
    });
    for (const bad of [
      undefined,
      '',
      `dsp_${hex}_${secret}`,
      `Bearer dsp_${hex}_${secret}x`,
      `Bearer dsp_${hex.toUpperCase()}_${secret}`,
      `Basic dsp_${hex}_${secret}`,
      `Bearer dsp_${hex}_${secret} extra`,
    ]) {
      assert.equal(parseIntegrationToken(bad), null, String(bad));
    }
  });

  it('moves runs forward only; repeats are no-ops', () => {
    assert.equal(canMoveRun('queued', 'running'), true);
    assert.equal(canMoveRun('queued', 'succeeded'), true);
    assert.equal(canMoveRun('unknown', 'failed'), true);
    assert.equal(canMoveRun('running', 'timed_out'), true);
    assert.equal(canMoveRun('failed', 'failed'), true);
    assert.equal(canMoveRun('running', 'queued'), false);
    assert.equal(canMoveRun('running', 'unknown'), false);
    assert.equal(canMoveRun('succeeded', 'failed'), false);
    assert.equal(canMoveRun('cancelled', 'running'), false);
  });

  it('refuses event times outside the replay window', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    assert.equal(checkEventTime('2026-10-10T12:00:00Z', now), 'ok');
    assert.equal(checkEventTime('2026-10-10T11:59:59Z', now), 'too_old');
    assert.equal(checkEventTime('2026-10-17T12:05:00+00:00', now), 'ok');
    assert.equal(checkEventTime('2026-10-17T12:05:01Z', now), 'in_future');
  });

  it('validates events strictly, defaulting the trigger', () => {
    const event = {
      externalRunId: 'airflow:orders_daily/2026-10-17',
      name: 'orders_daily',
      status: 'running',
      occurredAt: '2026-10-17T12:00:00Z',
    };
    const parsed = PipelineRunEvent.safeParse(event);
    assert.equal(parsed.success && parsed.data.trigger, 'unknown');
    for (const bad of [
      { ...event, status: 'done' },
      { ...event, externalRunId: 'has space' },
      { ...event, occurredAt: 'yesterday' },
      { ...event, workspaceId: 'w' },
      { ...event, name: ' ' },
    ]) {
      assert.equal(PipelineRunEvent.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it('redacts secrets from summaries and bounds their length', () => {
    const text = [
      'connect postgres://loader:hunter2@db.internal:5432/app',
      'Authorization: Bearer abc.def.ghi',
      `token dsp_${hex}_${secret}`,
      'password=hunter2 api_key: "k 1" rows=10',
    ].join('\n');
    const out = redactRunSummary(text);
    assert.doesNotMatch(out, /hunter2|abc\.def|dsp_0192|k 1/);
    assert.match(out, /postgres:\/\/\[redacted\]@db\.internal/);
    assert.match(out, /rows=10/);
    assert.equal(redactRunSummary('x'.repeat(5000)).length, RUN_SUMMARY_MAX);
  });
});
