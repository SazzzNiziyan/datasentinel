import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RulePage } from '../../src/rules/RulePage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

const rule = {
  id: 'r1',
  datasetId: 'd9',
  name: 'Orders keep arriving',
  type: 'metric_change',
  severity: 'critical',
  enabled: true,
  version: 2,
  definition: {
    version: 1,
    type: 'metric_change',
    metric: 'row_count',
    comparisonWindowDays: 7,
    maxDropPercent: 30,
    minimumHistoryPoints: 3,
  },
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
  recentRuns: [
    {
      id: 'c2',
      ruleVersion: 2,
      trigger: 'manual',
      status: 'failed',
      expected: { comparisonWindowDays: 7, minimumHistoryPoints: 3 },
      actual: {
        current: 60,
        currentMethod: 'exact',
        baseline: 100,
        absoluteChange: -40,
        percentChange: -40,
        historyPoints: 3,
        windowStart: '2026-10-10T12:00:00.000Z',
        windowEnd: '2026-10-17T12:00:00.000Z',
      },
      error: null,
      createdAt: '2026-10-17T12:00:00.000Z',
      startedAt: '2026-10-17T12:00:00.000Z',
      endedAt: '2026-10-17T12:00:01.500Z',
      durationMs: 1500,
    },
    {
      id: 'c1',
      ruleVersion: 1,
      trigger: 'manual',
      status: 'insufficient_data',
      expected: { comparisonWindowDays: 7, minimumHistoryPoints: 3 },
      actual: { reason: 'short_history', historyPoints: 1 },
      error: null,
      createdAt: '2026-10-12T12:00:00.000Z',
      startedAt: null,
      endedAt: null,
      durationMs: 40,
    },
  ],
};

function renderAt(path: string) {
  render(
    <WithSession session={fakeSession(signedIn('viewer'))}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/rules/:ruleId" element={<RulePage />} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

describe('Rule page', () => {
  it('shows each check with its version, result, and what it measured', async () => {
    routeApi({ 'GET /workspaces/w1/rules/r1': () => rule });
    renderAt('/rules/r1');
    expect(
      await screen.findByRole('heading', { name: 'Orders keep arriving' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'The 20 most recent checks' });
    const [, latest, older] = within(table).getAllByRole('row');
    expect(latest).toHaveTextContent('v2');
    expect(latest).toHaveTextContent('Failed');
    expect(latest).toHaveTextContent(
      '60 (exact count) against a median of 100 from 3 profiles, 10 Oct to 17 Oct: -40 (-40%).',
    );
    expect(latest).toHaveTextContent('1.5 s');
    expect(older).toHaveTextContent('Not enough data');
    expect(older).toHaveTextContent('Only 1 earlier profile in the comparison window; 3 needed.');
    expect(screen.getByRole('link', { name: 'Back to the dataset' })).toHaveAttribute(
      'href',
      '/datasets/d9',
    );
  });

  it('says when a rule is not in this workspace', async () => {
    routeApi({
      'GET /workspaces/w1/rules/nope': () =>
        reply(404, { title: 'Rule not found.', status: 404, code: 'rule_not_found' }),
    });
    renderAt('/rules/nope');
    expect(await screen.findByRole('heading', { name: 'Rule not found' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});
