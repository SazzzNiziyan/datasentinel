import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { OverviewPage } from '../../src/pages/OverviewPage.tsx';
import { SettingsPage } from '../../src/pages/SettingsPage.tsx';
import { reply, routeApi } from '../api.ts';
import { WithSession } from '../session.tsx';

function renderPage(page: ReactNode) {
  render(
    <WithSession>
      <MemoryRouter>{page}</MemoryRouter>
    </WithSession>,
  );
}

/** Data rows of a table found by its caption (the header row is skipped). */
function bodyRows(caption: string) {
  const table = screen.getByRole('table', { name: caption });
  return within(table).getAllByRole('row').slice(1);
}

const incident = (id: string, severity: string, title: string) => ({
  id,
  title,
  severity,
  status: 'open',
  datasetId: 'd1',
  datasetName: 'orders',
  ruleId: 'r1',
  assignedMembershipId: null,
  assigneeName: null,
  failureCount: 1,
  lastFailureAt: '2026-10-18T08:00:00.000Z',
  openedAt: '2026-10-18T07:00:00.000Z',
  resolvedAt: null,
});
const page = (incidents: unknown[], total = incidents.length) => ({
  incidents,
  total,
  nextOffset: null,
});
const dataset = {
  id: 'd1',
  name: 'orders',
  stableKey: 'public.orders',
  sourceId: 's1',
  sourceName: 'warehouse',
  status: 'active',
  sensitivity: 'internal',
};
const ACTIVE = '/workspaces/w1/incidents?status=active&sort=priority&limit=10';
const CRITICAL = '/workspaces/w1/incidents?status=active&severity=critical&limit=1';

describe('Overview screen', () => {
  it('shows live incidents and datasets, with no sample-data notice', async () => {
    routeApi({
      [`GET ${ACTIVE}`]: () =>
        page([incident('i1', 'critical', 'Orders stale'), incident('i2', 'warning', 'Nulls')]),
      [`GET ${CRITICAL}`]: () => page([incident('i1', 'critical', 'Orders stale')], 1),
      'GET /workspaces/w1/datasets': () => [dataset],
    });
    renderPage(<OverviewPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Orders stale' })).toHaveAttribute(
      'href',
      '/incidents/i1',
    );
    expect(screen.queryByText(/Sample data/)).toBeNull();
    expect(screen.getByText('1 critical incidents')).toBeVisible();
    expect(bodyRows('Active incidents')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'orders' })).toHaveAttribute('href', '/datasets/d1');
  });

  it('says all is well, and offers a way to connect data, when nothing exists yet', async () => {
    routeApi({
      [`GET ${ACTIVE}`]: () => page([]),
      [`GET ${CRITICAL}`]: () => page([]),
      'GET /workspaces/w1/datasets': () => [],
    });
    renderPage(<OverviewPage />);
    expect(
      await screen.findByText('No active incidents', { selector: '.status-mark *, .status-mark' }),
    ).toBeVisible();
    expect(screen.getByText('No datasets yet')).toBeVisible();
  });

  it('explains a failed load', async () => {
    routeApi({
      [`GET ${ACTIVE}`]: () => reply(500, { code: 'x' }),
      [`GET ${CRITICAL}`]: () => page([]),
      'GET /workspaces/w1/datasets': () => [],
    });
    renderPage(<OverviewPage />);
    expect(await screen.findByText('Could not load incidents')).toBeVisible();
  });
});

describe('Workspace settings screen', () => {
  it('explains that the current role cannot change member roles', () => {
    renderPage(<SettingsPage />);
    expect(screen.getByRole('heading', { name: "You can't manage members" })).toBeVisible();
  });
});
