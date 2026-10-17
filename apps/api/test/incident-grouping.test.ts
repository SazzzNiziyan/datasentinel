import {
  decideGrouping,
  INCIDENT_REOPEN_WINDOW_MS,
  incidentDedupeKey,
  incidentStatuses,
  qualifiesForIncident,
} from '@datasentinel/contracts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('incident grouping', () => {
  it('keys incidents by rule', () => {
    assert.equal(incidentDedupeKey('r-1'), 'rule:r-1');
    assert.notEqual(incidentDedupeKey('r-1'), incidentDedupeKey('r-2'));
  });

  it('opens incidents only for failed checks of critical rules', () => {
    assert.equal(qualifiesForIncident({ status: 'failed', ruleSeverity: 'critical' }), true);
    for (const status of ['passed', 'error', 'insufficient_data', 'queued', 'running']) {
      assert.equal(qualifiesForIncident({ status, ruleSeverity: 'critical' }), false, status);
    }
    assert.equal(qualifiesForIncident({ status: 'failed', ruleSeverity: 'warning' }), false);
    assert.equal(qualifiesForIncident({ status: 'failed', ruleSeverity: 'info' }), false);
  });

  it('appends to any unresolved incident, however old', () => {
    for (const status of incidentStatuses.filter((s) => s !== 'resolved')) {
      assert.equal(decideGrouping({ status, resolvedAt: null }, NOW), 'append', status);
    }
  });

  it('reopens a recently resolved incident and opens a new one after the window', () => {
    const resolved = (ms: number) => ({ status: 'resolved' as const, resolvedAt: ago(ms) });
    assert.equal(decideGrouping(resolved(60_000), NOW), 'reopen');
    assert.equal(decideGrouping(resolved(INCIDENT_REOPEN_WINDOW_MS), NOW), 'reopen');
    assert.equal(decideGrouping(resolved(INCIDENT_REOPEN_WINDOW_MS + 1), NOW), 'create');
    assert.equal(decideGrouping({ status: 'resolved', resolvedAt: null }, NOW), 'create');
  });

  it('creates an incident when none exists', () => {
    assert.equal(decideGrouping(null, NOW), 'create');
  });
});
