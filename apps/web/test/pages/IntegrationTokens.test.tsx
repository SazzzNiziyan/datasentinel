import type { IntegrationTokenSummary, SourceSummary } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourcesPage } from '../../src/pages/SourcesPage.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

afterEach(() => vi.unstubAllGlobals());

const BASE = '/workspaces/w1/sources/s1/integration-tokens';
const LIST = `GET ${BASE}`;
const SOURCES = 'GET /workspaces/w1/sources';

const source = (over: Partial<SourceSummary> = {}): SourceSummary => ({
  id: 's1',
  name: 'Nightly ETL',
  type: 'pipeline_event',
  status: 'active',
  ownerName: null,
  datasetCount: 0,
  lastCheckedAt: null,
  ...over,
});

const token = (over: Partial<IntegrationTokenSummary>): IntegrationTokenSummary => ({
  id: 't1',
  name: 'Airflow',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  ...over,
});

function renderSources(role: Parameters<typeof signedIn>[0] = 'admin') {
  render(
    <WithSession session={fakeSession(signedIn(role))}>
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>
    </WithSession>,
  );
}

const user = () => userEvent.setup();

describe('Integration tokens', () => {
  it('lists tokens with their state and never a secret', async () => {
    routeApi({
      [SOURCES]: () => [source()],
      [LIST]: () => [
        token({}),
        token({ id: 't2', name: 'Old', expiresAt: '2020-01-01T00:00:00.000Z' }),
        token({ id: 't3', name: 'Gone', revokedAt: '2026-10-02T10:00:00.000Z' }),
        token({ id: 't4', name: 'Forever', expiresAt: null }),
      ],
    });
    renderSources();
    await screen.findByText('Airflow');
    const table = screen.getByRole('table', { name: 'Integration tokens' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Active');
    expect(rows[0]).toHaveTextContent('Never');
    expect(rows[1]).toHaveTextContent('Expired');
    expect(rows[2]).toHaveTextContent('Revoked');
    expect(rows[3]).toHaveTextContent('Active');
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
    expect(within(rows[3]!).getByRole('button', { name: 'Revoke Forever' })).toBeVisible();
    expect(table).not.toHaveTextContent(/dsit_|token_/i);
  });

  it('shows an empty state', async () => {
    routeApi({ [SOURCES]: () => [source()], [LIST]: () => [] });
    renderSources();
    expect(await screen.findByText('No integration tokens')).toBeVisible();
  });

  it('creates with 365 days by default and shows the token once', async () => {
    const calls = routeApi({
      [SOURCES]: () => [source()],
      [LIST]: () => [],
      [`POST ${BASE}`]: () => reply(201, { ...token({}), token: 'dsit_secret123' }),
    });
    renderSources();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Create token' }));
    await u.type(screen.getByLabelText('Name'), 'Airflow');
    await u.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('dsit_secret123')).toBeVisible();
    expect(screen.getByText(/copy it now, it is not shown again/)).toBeVisible();
    expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
      name: 'Airflow',
      expiresInDays: 365,
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.key === LIST.toString())).toHaveLength(2));
    await u.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('dsit_secret123')).toBeNull();
  });

  it('sends the chosen expiry', async () => {
    const calls = routeApi({
      [SOURCES]: () => [source()],
      [LIST]: () => [],
      [`POST ${BASE}`]: () => reply(201, { ...token({}), token: 'dsit_x' }),
    });
    renderSources();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Create token' }));
    await u.type(screen.getByLabelText('Name'), 'Short');
    await u.selectOptions(screen.getByLabelText('Expires in'), '30 days');
    await u.click(screen.getByRole('button', { name: 'Create token' }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
        name: 'Short',
        expiresInDays: 30,
      }),
    );
  });

  it('shows the server reason when creating fails', async () => {
    routeApi({
      [SOURCES]: () => [source()],
      [LIST]: () => [],
      [`POST ${BASE}`]: () =>
        reply(409, { code: 'conflict', title: 'Conflict', detail: 'Too many tokens.' }),
    });
    renderSources();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Create token' }));
    await u.type(screen.getByLabelText('Name'), 'X');
    await u.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tokens.');
  });

  it('revokes only after confirming, then reloads', async () => {
    const calls = routeApi({
      [SOURCES]: () => [source()],
      [LIST]: () => [token({})],
      [`DELETE ${BASE}/t1`]: () => reply(204, undefined),
    });
    renderSources();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Revoke Airflow' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke this token?' });
    expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
    await u.click(within(dialog).getByRole('button', { name: 'Revoke token' }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === `DELETE ${BASE}/t1`)).toBe(true));
    await vi.waitFor(() => expect(calls.filter((c) => c.key === LIST)).toHaveLength(2));
  });

  it('is hidden for an engineer', async () => {
    const calls = routeApi({ [SOURCES]: () => [source()] });
    renderSources('engineer');
    await screen.findByRole('table', { name: 'Data sources' });
    expect(screen.queryByRole('heading', { name: 'Integration tokens' })).toBeNull();
    expect(calls.filter((c) => c.key.includes('integration-tokens'))).toEqual([]);
  });

  it('is hidden for sources that are not pipeline events', async () => {
    const calls = routeApi({ [SOURCES]: () => [source({ type: 'csv' })] });
    renderSources();
    await screen.findByRole('table', { name: 'Data sources' });
    expect(screen.queryByRole('heading', { name: 'Integration tokens' })).toBeNull();
    expect(calls.filter((c) => c.key.includes('integration-tokens'))).toEqual([]);
  });
});
