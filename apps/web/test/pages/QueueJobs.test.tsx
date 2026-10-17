import type { QueueJobList } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../src/pages/SettingsPage.tsx';
import { routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

afterEach(() => vi.unstubAllGlobals());

const KEY = 'GET /workspaces/w1/queue-jobs';

function renderSettings(role: Parameters<typeof signedIn>[0]) {
  render(
    <WithSession session={fakeSession(signedIn(role))}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </WithSession>,
  );
}

const list: QueueJobList = {
  omitted: 2,
  jobs: [
    {
      queue: 'checks',
      jobId: '1',
      name: 'run-check',
      state: 'failed',
      attemptsMade: 3,
      attempts: 3,
      addedAt: '2026-10-17T10:00:00.000Z',
      finishedAt: '2026-10-17T10:05:00.000Z',
      failure: 'Connection refused',
    },
    {
      queue: 'profiles',
      jobId: '2',
      name: 'mystery-job',
      state: 'stalled',
      attemptsMade: 1,
      attempts: 3,
      addedAt: '2026-10-17T09:00:00.000Z',
      finishedAt: null,
      failure: null,
    },
  ],
};

describe('Background jobs panel', () => {
  it('shows failed and stalled jobs to an admin', async () => {
    routeApi({
      'GET /workspaces/w1/members': () => [],
      'GET /workspaces/w1/invitations': () => [],
      [KEY]: () => list,
    });
    renderSettings('admin');
    const table = await screen.findByRole('table', { name: 'Failed and stalled background jobs' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Rule check');
    expect(rows[0]).toHaveTextContent('Failed');
    expect(rows[0]).toHaveTextContent('3 of 3');
    expect(rows[0]).toHaveTextContent('Connection refused');
    expect(rows[1]).toHaveTextContent('mystery-job');
    expect(rows[1]).toHaveTextContent('Stalled');
    expect(rows[1]).toHaveTextContent('—');
    expect(screen.getByText('2 more jobs are not shown.')).toBeVisible();
  });

  it('explains an empty list', async () => {
    routeApi({
      'GET /workspaces/w1/members': () => [],
      'GET /workspaces/w1/invitations': () => [],
      [KEY]: () => ({ jobs: [], omitted: 0 }),
    });
    renderSettings('owner');
    expect(await screen.findByText('No failed or stalled jobs')).toBeVisible();
    expect(screen.queryByText(/more jobs are not shown/)).toBeNull();
  });

  it.each(['engineer', 'viewer'] as const)('is hidden and not fetched for a %s', async (role) => {
    const calls = routeApi({});
    renderSettings(role);
    expect(await screen.findByRole('heading', { name: "You can't manage members" })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Background jobs' })).toBeNull();
    expect(calls.filter((c) => c.key.includes('/queue-jobs'))).toEqual([]);
  });
});
