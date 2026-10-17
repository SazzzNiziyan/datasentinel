import type { IncidentDetail } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { IncidentDetailPage } from '../../src/incidents/IncidentDetailPage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

const incident: IncidentDetail = {
  id: 'i1',
  title: 'Orders are stale',
  severity: 'critical',
  status: 'reopened',
  datasetId: 'd1',
  datasetName: 'Orders',
  ruleId: 'r1',
  ruleName: 'Orders keep arriving',
  ruleType: 'freshness',
  sourceId: 's1',
  assignedMembershipId: null,
  assigneeName: null,
  failureCount: 4,
  lastFailureAt: '2026-10-17T10:00:00.000Z',
  openedAt: '2026-10-17T09:00:00.000Z',
  resolvedAt: null,
  resolutionNote: null,
  latestCheck: {
    checkRunId: 'c1',
    observedAt: '2026-10-17T10:00:00.000Z',
    ruleVersion: 2,
    expected: { maxAgeMinutes: 60 },
    actual: { ageMinutes: 180 },
  },
  relatedRuns: [
    {
      pipelineRunId: 'p1',
      name: 'nightly-load',
      status: 'failed',
      sourceName: 'Warehouse',
      reason: 'dataset_id',
      distanceMinutes: 0,
      observedAt: '2026-10-17T09:30:00.000Z',
    },
    {
      pipelineRunId: 'p2',
      name: 'hourly-sync',
      status: 'succeeded',
      sourceName: 'Warehouse',
      reason: 'correlation_id',
      distanceMinutes: 1,
      observedAt: '2026-10-17T09:59:00.000Z',
    },
  ],
  evidence: [
    {
      id: 'e1',
      kind: 'check_run',
      referenceId: 'c1',
      observedAt: '2026-10-17T10:00:00.000Z',
      summary: { status: 'failed', nested: { a: 1 }, ageMinutes: 180 },
    },
    {
      id: 'e2',
      kind: 'pipeline_run',
      referenceId: 'p1',
      observedAt: '2026-10-17T09:30:00.000Z',
      summary: { name: 'nightly-load' },
    },
  ],
  history: [
    {
      id: 'h1',
      type: 'opened',
      actorType: 'system',
      actorName: null,
      fromStatus: null,
      toStatus: 'open',
      details: {},
      createdAt: '2026-10-17T09:00:00.000Z',
    },
    {
      id: 'h2',
      type: 'reopened',
      actorType: 'system',
      actorName: null,
      fromStatus: 'resolved',
      toStatus: 'reopened',
      details: { automatic: true },
      createdAt: '2026-10-17T10:00:00.000Z',
    },
  ],
};

function renderAt(path: string) {
  render(
    <WithSession session={fakeSession(signedIn('viewer'))}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

describe('Incident detail page', () => {
  it('shows the summary, failed check, related runs, evidence, and history', async () => {
    routeApi({ 'GET /workspaces/w1/incidents/i1': () => incident });
    renderAt('/incidents/i1');
    expect(await screen.findByRole('heading', { name: 'Orders are stale' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/datasets/d1');
    expect(screen.getByRole('link', { name: 'Orders keep arriving' })).toHaveAttribute(
      'href',
      '/rules/r1',
    );
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Reopened')).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Expected' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Actual' })).toBeInTheDocument();
    expect(screen.getByText('max age minutes')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('age minutes')).toBeInTheDocument();
    expect(screen.getByText('180')).toBeInTheDocument();
    expect(screen.getByText(/Rule version 2/)).toBeInTheDocument();

    const runs = screen.getByRole('table', { name: 'Pipeline runs linked to this incident' });
    const [, first, second] = within(runs).getAllByRole('row');
    expect(first).toHaveTextContent('nightly-load');
    expect(first).toHaveTextContent('Failed');
    expect(first).toHaveTextContent('The run names this dataset');
    expect(first).toHaveTextContent('Active during the check');
    expect(second).toHaveTextContent('Succeeded');
    expect(second).toHaveTextContent("The run references this dataset's ID");
    expect(second).toHaveTextContent('1 minute before the check');

    const evidence = screen.getByRole('table', { name: 'Evidence for this incident' });
    const [, e1, e2] = within(evidence).getAllByRole('row');
    expect(e1).toHaveTextContent('Failed check');
    expect(e1).toHaveTextContent('status: failed, ageMinutes: 180');
    expect(e1).not.toHaveTextContent('nested');
    expect(e2).toHaveTextContent('Pipeline run');

    const history = screen.getByRole('list', { name: 'Incident history' });
    expect(within(history).getByText('Incident opened')).toBeInTheDocument();
    expect(
      within(history).getByText(
        'Incident reopened automatically after a repeat failure (Resolved to Reopened)',
      ),
    ).toBeInTheDocument();
  });

  it('explains a missing check result and no related runs', async () => {
    routeApi({
      'GET /workspaces/w1/incidents/i1': () => ({
        ...incident,
        latestCheck: null,
        relatedRuns: [],
      }),
    });
    renderAt('/incidents/i1');
    expect(await screen.findByText('No check result is attached yet.')).toBeInTheDocument();
    expect(screen.getByText('No pipeline run is linked to this incident.')).toBeInTheDocument();
  });

  it('shows an error with a retry button when the incident is not found', async () => {
    routeApi({
      'GET /workspaces/w1/incidents/nope': () =>
        reply(404, { title: 'Incident not found.', status: 404, code: 'incident_not_found' }),
    });
    renderAt('/incidents/nope');
    expect(await screen.findByRole('heading', { name: 'Incident not found' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
