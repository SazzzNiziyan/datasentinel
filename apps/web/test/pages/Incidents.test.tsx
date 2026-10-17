import type { IncidentListItem } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { IncidentsPage } from '../../src/pages/IncidentsPage.tsx';
import { routeApi } from '../api.ts';
import { WithSession } from '../session.tsx';

const incident = (id: string, over: Partial<IncidentListItem> = {}): IncidentListItem => ({
  id,
  title: `Incident ${id}`,
  severity: 'critical',
  status: 'open',
  datasetId: 'd1',
  datasetName: 'Orders',
  ruleId: 'r1',
  assignedMembershipId: null,
  assigneeName: null,
  failureCount: 3,
  lastFailureAt: '2026-10-17T10:00:00.000Z',
  openedAt: '2026-10-17T09:00:00.000Z',
  resolvedAt: null,
  ...over,
});

const base = '/workspaces/w1/incidents';
const def = `GET ${base}?status=active&sort=priority&limit=25`;

function renderPage() {
  render(
    <WithSession>
      <MemoryRouter>
        <IncidentsPage />
      </MemoryRouter>
    </WithSession>,
  );
}

describe('Incidents page', () => {
  it('lists incidents with severity, status, dataset link and assignee', async () => {
    const calls = routeApi({
      [def]: () => ({
        incidents: [
          incident('a'),
          incident('b', { severity: 'warning', status: 'investigating', assigneeName: 'Sam' }),
        ],
        total: 2,
        nextOffset: null,
      }),
    });
    renderPage();
    const table = await screen.findByRole('table', { name: 'Incidents' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Critical');
    expect(rows[0]).toHaveTextContent('Open');
    expect(rows[0]).toHaveTextContent('Unassigned');
    expect(within(rows[0]!).getByRole('link', { name: 'Orders' })).toHaveAttribute(
      'href',
      '/datasets/d1',
    );
    expect(within(rows[0]!).getByRole('link', { name: 'Incident a' })).toHaveAttribute(
      'href',
      '/incidents/a',
    );
    expect(rows[1]).toHaveTextContent('Investigating');
    expect(rows[1]).toHaveTextContent('Sam');
    expect(screen.getByText('2 incidents')).toBeVisible();
    expect(calls[0]!.key).toBe(def);
  });

  it('refetches with severity and assignee filters', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      [def]: () => ({ incidents: [incident('a')], total: 1, nextOffset: null }),
      [`GET ${base}?status=active&severity=critical&sort=priority&limit=25`]: () => ({
        incidents: [incident('a')],
        total: 1,
        nextOffset: null,
      }),
      [`GET ${base}?status=active&severity=critical&assignee=me&sort=priority&limit=25`]: () => ({
        incidents: [incident('m', { assigneeName: 'Me Myself' })],
        total: 1,
        nextOffset: null,
      }),
    });
    renderPage();
    await screen.findByText('Incident a');
    expect(screen.getByText('1 incident')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Severity'), 'Critical');
    await user.selectOptions(screen.getByLabelText('Assigned to'), 'Me');
    expect(await screen.findByText('Incident m')).toBeVisible();
    expect(screen.queryByText('Incident a')).toBeNull();
    expect(calls.map((c) => c.key)).toContain(
      `GET ${base}?status=active&severity=critical&assignee=me&sort=priority&limit=25`,
    );
  });

  it('sorts by most recent failure', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      [def]: () => ({ incidents: [incident('a')], total: 1, nextOffset: null }),
      [`GET ${base}?status=active&sort=recent&limit=25`]: () => ({
        incidents: [incident('r')],
        total: 1,
        nextOffset: null,
      }),
    });
    renderPage();
    await screen.findByText('Incident a');
    await user.selectOptions(screen.getByLabelText('Sort by'), 'Most recent failure');
    expect(await screen.findByText('Incident r')).toBeVisible();
    expect(calls.map((c) => c.key)).toContain(`GET ${base}?status=active&sort=recent&limit=25`);
  });

  it('appends more incidents and hides the button on the last page', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      [def]: () => ({ incidents: [incident('a')], total: 2, nextOffset: 25 }),
      [`GET ${base}?status=active&sort=priority&limit=25&offset=25`]: () => ({
        incidents: [incident('b')],
        total: 2,
        nextOffset: null,
      }),
    });
    renderPage();
    await screen.findByText('Incident a');
    await user.click(screen.getByRole('button', { name: 'Show more incidents' }));
    expect(await screen.findByText('Incident b')).toBeVisible();
    expect(screen.getByText('Incident a')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show more incidents' })).toBeNull();
    expect(calls.map((c) => c.key)).toContain(
      `GET ${base}?status=active&sort=priority&limit=25&offset=25`,
    );
  });

  it('explains an empty default list and a filter with no matches', async () => {
    const user = userEvent.setup();
    routeApi({
      [def]: () => ({ incidents: [], total: 0, nextOffset: null }),
      [`GET ${base}?status=active&severity=info&sort=priority&limit=25`]: () => ({
        incidents: [],
        total: 0,
        nextOffset: null,
      }),
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No open incidents' })).toBeVisible();
    expect(
      screen.getByText('Failed checks on critical rules open incidents automatically.'),
    ).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Severity'), 'Info');
    expect(
      await screen.findByRole('heading', { name: 'No incidents match these filters' }),
    ).toBeVisible();
  });
});
