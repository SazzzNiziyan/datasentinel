import type {
  IncidentDetail,
  IncidentHistoryItem,
  IncidentStatus,
  MemberSummary,
  Role,
} from '@datasentinel/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { IncidentDetailPage } from '../../src/incidents/IncidentDetailPage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

const make = (status: IncidentStatus, extra: Partial<IncidentDetail> = {}): IncidentDetail => ({
  id: 'i1',
  title: 'Orders are stale',
  severity: 'critical',
  status,
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
  latestCheck: null,
  relatedRuns: [],
  evidence: [],
  history: [],
  comments: [],
  ...extra,
});

const ada = '11111111-1111-4111-8111-111111111111';
const members: MemberSummary[] = [
  {
    membershipId: ada,
    userId: 'u2',
    displayName: 'Ada',
    email: 'ada@x.example',
    role: 'engineer',
    status: 'active',
  },
  {
    membershipId: '22222222-2222-4222-8222-222222222222',
    userId: 'u3',
    displayName: 'Gone Gary',
    email: 'gary@x.example',
    role: 'engineer',
    status: 'removed',
  },
];

const GET = 'GET /workspaces/w1/incidents/i1';
const PATCH = 'PATCH /workspaces/w1/incidents/i1';
const MEMBERS = 'GET /workspaces/w1/members';

function renderAs(role: Role) {
  render(
    <WithSession session={fakeSession(signedIn(role))}>
      <MemoryRouter initialEntries={['/incidents/i1']}>
        <Routes>
          <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

const button = (name: string) => screen.queryByRole('button', { name });

describe('Incident actions', () => {
  it('acknowledges an open incident and shows the new status', async () => {
    const calls = routeApi({
      [GET]: () => make('open'),
      [MEMBERS]: () => members,
      [PATCH]: () => make('acknowledged'),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(button('Acknowledge')).toBeNull());
    expect(calls.find((c) => c.key === PATCH)?.body).toEqual({
      status: 'acknowledged',
      expectedStatus: 'open',
    });
    expect(screen.getByRole('heading', { name: 'Actions' })).toBeInTheDocument();
    expect(button('Start investigating')).toBeInTheDocument();
    expect(button('Resolve')).toBeInTheDocument();
    expect(button('Reopen')).toBeNull();
  });

  it('offers Acknowledge, Start investigating, and Resolve on an open incident', async () => {
    routeApi({ [GET]: () => make('open'), [MEMBERS]: () => members });
    renderAs('engineer');
    expect(await screen.findByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(button('Start investigating')).toBeInTheDocument();
    expect(button('Resolve')).toBeInTheDocument();
    expect(button('Reopen')).toBeNull();
  });

  it('refuses an empty resolution note, then resolves with one', async () => {
    const calls = routeApi({
      [GET]: () => make('open'),
      [MEMBERS]: () => members,
      [PATCH]: () => make('resolved', { resolutionNote: 'Restarted the loader' }),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve incident' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resolve incident' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Write a resolution note.');
    expect(calls.some((c) => c.key === PATCH)).toBe(false);

    await userEvent.type(
      within(dialog).getByLabelText('Resolution note'),
      '  Restarted the loader ',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resolve incident' }));
    expect(await screen.findByText('Restarted the loader')).toBeInTheDocument();
    expect(calls.find((c) => c.key === PATCH)?.body).toEqual({
      status: 'resolved',
      expectedStatus: 'open',
      resolutionNote: 'Restarted the loader',
    });
  });

  it('shows only Reopen on a resolved incident and sends the reason', async () => {
    const calls = routeApi({
      [GET]: () => make('resolved'),
      [MEMBERS]: () => members,
      [PATCH]: () => make('reopened'),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    expect(button('Acknowledge')).toBeNull();
    expect(button('Resolve')).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Reopen incident' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen incident' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give a reason.');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Fix did not hold');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reopen incident' }));
    await waitFor(() => expect(calls.some((c) => c.key === PATCH)).toBe(true));
    expect(calls.find((c) => c.key === PATCH)?.body).toEqual({
      status: 'reopened',
      expectedStatus: 'resolved',
      reason: 'Fix did not hold',
    });
  });

  it('shows no Actions panel to a viewer and does not load members', async () => {
    const calls = routeApi({ [GET]: () => make('open') });
    renderAs('viewer');
    expect(await screen.findByRole('heading', { name: 'Orders are stale' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
    expect(calls.some((c) => c.key === MEMBERS)).toBe(false);
  });

  it('assigns an active member and unassigns', async () => {
    const calls = routeApi({
      [GET]: () => make('open'),
      [MEMBERS]: () => members,
      [PATCH]: [
        () => make('open', { assignedMembershipId: ada, assigneeName: 'Ada' }),
        () => make('open'),
      ],
    });
    renderAs('engineer');
    const select = await screen.findByRole('combobox', { name: 'Assigned to' });
    expect(within(select).queryByRole('option', { name: 'Gone Gary' })).toBeNull();
    await userEvent.selectOptions(select, 'Ada');
    await waitFor(() => expect(select).toHaveValue(ada));
    await userEvent.selectOptions(select, 'Unassigned');
    await waitFor(() => expect(select).toHaveValue(''));
    const bodies = calls.filter((c) => c.key === PATCH).map((c) => c.body);
    expect(bodies).toEqual([{ assignedMembershipId: ada }, { assignedMembershipId: null }]);
  });

  it('shows the problem and reloads on a changed incident', async () => {
    const calls = routeApi({
      [GET]: [() => make('open'), () => make('acknowledged')],
      [MEMBERS]: () => members,
      [PATCH]: () =>
        reply(409, {
          title: 'Incident changed.',
          detail: 'Someone else changed this incident. Review it and try again.',
          status: 409,
          code: 'incident_changed',
        }),
    });
    renderAs('engineer');
    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this');
    await waitFor(() => expect(button('Acknowledge')).toBeNull());
    expect(calls.filter((c) => c.key === GET)).toHaveLength(2);
  });

  it('writes the new history texts', async () => {
    const event = (
      id: string,
      type: string,
      details: Record<string, unknown>,
      from: IncidentStatus | null = null,
      to: IncidentStatus | null = null,
    ): IncidentHistoryItem => ({
      id,
      type,
      actorType: 'user',
      actorName: 'Ana',
      fromStatus: from,
      toStatus: to,
      details,
      createdAt: '2026-10-17T10:00:00.000Z',
    });
    routeApi({
      [GET]: () =>
        make('reopened', {
          history: [
            event('a', 'acknowledged', {}, 'open', 'acknowledged'),
            event('b', 'investigating', {}, 'acknowledged', 'investigating'),
            event(
              'c',
              'resolved',
              { resolutionNote: 'Loader restarted' },
              'investigating',
              'resolved',
            ),
            event(
              'd',
              'reopened',
              { automatic: false, reason: 'Broke again' },
              'resolved',
              'reopened',
            ),
            event('e', 'assigned', { toName: 'Ada' }),
            event('f', 'unassigned', {}),
          ],
        }),
    });
    renderAs('viewer');
    const history = await screen.findByRole('list', { name: 'Incident history' });
    for (const text of [
      'Acknowledged',
      'Investigation started',
      'Resolved: Loader restarted',
      'Reopened: Broke again',
      'Assigned to Ada',
      'Unassigned',
    ]) {
      expect(within(history).getByText(text)).toBeInTheDocument();
    }
  });
});
