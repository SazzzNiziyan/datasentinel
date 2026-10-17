import type { Role } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DatasetDetailPage } from '../../src/pages/DatasetDetailPage.tsx';
import { SourcesPage } from '../../src/pages/SourcesPage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

const source = {
  id: 's1',
  name: 'Finance exports',
  type: 'csv',
  status: 'active',
  ownerName: null,
  datasetCount: 1,
  lastCheckedAt: null,
};

const dataset = {
  id: 'd9',
  name: 'Daily sales',
  stableKey: 'daily-sales',
  sourceId: 's1',
  sourceName: 'Finance exports',
  status: 'active',
  sensitivity: 'internal',
  description: null,
  ownerName: null,
  locator: { format: 'csv' },
  createdAt: '2026-10-17T09:00:00.000Z',
  archivedAt: null,
  latestProfile: null,
  lastSuccessfulProfile: null,
};

function renderAs(role: Role, page: ReactNode, path = '/') {
  render(
    <WithSession session={fakeSession(signedIn(role))}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={page} />
          <Route path="/datasets/:datasetId" element={page} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

describe('Source actions', () => {
  it('lets a data engineer pause a source and shows the new state', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': [() => [source], () => [{ ...source, status: 'paused' }]],
      'POST /workspaces/w1/sources/s1/pause': () => ({ ...source, status: 'paused' }),
    });
    renderAs('engineer', <SourcesPage />);
    await user.click(await screen.findByRole('button', { name: 'Pause Finance exports' }));
    expect(await screen.findByRole('button', { name: 'Resume Finance exports' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Paused' })).toBeVisible();
    expect(calls.map((c) => c.key)).toContain('POST /workspaces/w1/sources/s1/pause');
    // Archiving is for administrators.
    expect(screen.queryByRole('button', { name: 'Archive Finance exports' })).toBeNull();
  });

  it('asks an administrator to confirm before archiving', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': [() => [source], () => []],
      'DELETE /workspaces/w1/sources/s1': () => ({ ...source, status: 'archived' }),
    });
    renderAs('admin', <SourcesPage />);
    await user.click(await screen.findByRole('button', { name: 'Archive Finance exports' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this source?' });
    expect(dialog).toHaveTextContent('all its datasets');
    expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Archive source' }));
    expect(await screen.findByRole('heading', { name: 'No data sources yet' })).toBeVisible();
    expect(calls.map((c) => c.key)).toContain('DELETE /workspaces/w1/sources/s1');
  });

  it('shows archived sources on request, without actions', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => [source],
      'GET /workspaces/w1/sources?status=archived': () => [{ ...source, status: 'archived' }],
    });
    renderAs('owner', <SourcesPage />);
    const toggle = await screen.findByRole('button', { name: 'Show archived sources' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const table = await screen.findByRole('table', { name: 'Archived data sources' });
    expect(await within(table).findByText('Archived')).toBeVisible();
    expect(within(table).queryByRole('button', { name: /Pause|Resume|Archive/ })).toBeNull();
    expect(calls.map((c) => c.key)).toContain('GET /workspaces/w1/sources?status=archived');
  });

  it('offers no actions to analysts', async () => {
    routeApi({ 'GET /workspaces/w1/sources': () => [source] });
    renderAs('analyst', <SourcesPage />);
    await screen.findByText('Finance exports');
    expect(screen.queryByRole('button', { name: /Pause|Archive/ })).toBeNull();
  });
});

describe('Dataset actions', () => {
  const uploads = {
    'GET /workspaces/w1/uploads?datasetId=d9': () => [],
    'GET /workspaces/w1/datasets/d9/rules': () => [],
    'GET /workspaces/w1/datasets/d9/schedules': () => [],
    'GET /workspaces/w1/datasets/d9/profiles': () => [],
  };

  it('shows the status and why a resume was refused', async () => {
    const user = userEvent.setup();
    routeApi({
      ...uploads,
      'GET /workspaces/w1/datasets/d9': () => ({ ...dataset, status: 'paused' }),
      'POST /workspaces/w1/datasets/d9/resume': () =>
        reply(409, {
          title: 'Its source is paused.',
          detail: 'Resume the source first.',
          status: 409,
          code: 'source_not_active',
        }),
    });
    renderAs('engineer', <DatasetDetailPage />, '/datasets/d9');
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Status').nextSibling).toHaveTextContent('Paused');
    await user.click(screen.getByRole('button', { name: 'Resume Daily sales' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Its source is paused. Resume the source first.',
    );
  });

  it('marks an archived dataset and offers no changes', async () => {
    routeApi({
      ...uploads,
      'GET /workspaces/w1/datasets/d9': () => ({
        ...dataset,
        status: 'archived',
        archivedAt: '2026-10-17T10:00:00.000Z',
      }),
    });
    renderAs('owner', <DatasetDetailPage />, '/datasets/d9');
    expect(await screen.findByText(/Archived 17 Oct 2026, 10:00 UTC/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Upload CSV|Pause|Archive/ })).toBeNull();
  });

  it('profiles a database dataset now and shows the new profile', async () => {
    const user = userEvent.setup();
    const pgDataset = { ...dataset, locator: { schema: 'public', table: 'orders' } };
    const latest = {
      id: 'p1',
      status: 'succeeded',
      observedAt: '2026-10-17T10:00:00.000Z',
      rowCount: 2_500_000,
      rowCountMethod: 'approximate',
      lastUpdatedAt: null,
      error: null,
      columns: [{ name: 'id', type: 'integer', nullCount: null, ordinal: 1 }],
    };
    const profiled = { ...pgDataset, latestProfile: latest, lastSuccessfulProfile: latest };
    routeApi({
      ...uploads,
      'GET /workspaces/w1/datasets/d9': [() => pgDataset, () => profiled, () => profiled],
      'POST /workspaces/w1/datasets/d9/profile-runs': () => reply(202, { status: 'queued' }),
    });
    renderAs('engineer', <DatasetDetailPage />, '/datasets/d9');
    expect(screen.queryByRole('button', { name: 'Upload CSV' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Profile now' }));
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(
      await within(summary).findByText('About 2,500,000', {}, { timeout: 4000 }),
    ).toBeVisible();
    expect(screen.getByText('Not counted')).toBeVisible();
  });
});
