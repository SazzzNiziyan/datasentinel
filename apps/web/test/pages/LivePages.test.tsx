import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { DatasetsPage } from '../../src/pages/DatasetsPage.tsx';
import { SourcesPage } from '../../src/pages/SourcesPage.tsx';
import { WithSession } from '../session.tsx';

function renderPage(page: ReactNode) {
  render(
    <WithSession>
      <MemoryRouter>{page}</MemoryRouter>
    </WithSession>,
  );
}

/** Answers each request with the next body; the network is otherwise off. */
function stubApi(...answers: (() => Promise<Response>)[]) {
  const queue = [...answers];
  const fetch = vi.fn(() => (queue.shift() ?? (() => Promise.reject(new TypeError('offline'))))());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

const source = {
  id: 's1',
  name: 'warehouse_prod',
  type: 'postgres',
  status: 'active',
  ownerName: 'Ana Kovac',
  datasetCount: 2,
  lastCheckedAt: null,
};

describe('Data sources screen', () => {
  it('lists the workspace’s sources from the API, with no sample label', async () => {
    const fetch = stubApi(json([source]));
    renderPage(<SourcesPage />);
    const table = await screen.findByRole('table', { name: 'Data sources' });
    expect(await within(table).findByText('warehouse_prod')).toBeVisible();
    expect(within(table).getByText('PostgreSQL')).toBeVisible();
    expect(within(table).getByText('Not checked yet')).toBeVisible();
    expect(screen.queryByText(/Sample data/)).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/workspaces\/w1\/sources$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('explains an empty workspace', async () => {
    stubApi(json([]));
    renderPage(<SourcesPage />);
    expect(await screen.findByRole('heading', { name: 'No data sources yet' })).toBeVisible();
  });

  it('shows the API problem and loads again on Try again', async () => {
    const user = userEvent.setup();
    stubApi(
      json(
        { title: 'Something went wrong on our side.', status: 500, code: 'internal_error' },
        500,
      ),
      json([source]),
    );
    renderPage(<SourcesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load data sources');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('warehouse_prod')).toBeVisible();
  });
});

describe('Datasets screen', () => {
  it('lists datasets with their source and location', async () => {
    stubApi(
      json([
        {
          id: 'd1',
          name: 'orders',
          stableKey: 'public.orders',
          sourceId: 's1',
          sourceName: 'warehouse_prod',
          status: 'active',
          sensitivity: 'internal',
        },
      ]),
    );
    renderPage(<DatasetsPage />);
    expect(await screen.findByText('public.orders')).toBeVisible();
    expect(screen.getByText('warehouse_prod')).toBeVisible();
    expect(screen.getByText('Internal')).toBeVisible();
  });
});
