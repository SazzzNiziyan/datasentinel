import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlePing } from '../src/jobs/ping.js';

describe('ping job', () => {
  it('answers with the time it was sent', () => {
    assert.deepEqual(handlePing({ sentAt: '2026-10-17T00:00:00.000Z' }), {
      pong: true,
      sentAt: '2026-10-17T00:00:00.000Z',
    });
  });
});
