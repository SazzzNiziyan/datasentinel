import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SourcesPage } from '../../src/pages/SourcesPage.tsx';
import { reply, routeApi } from '../api.ts';
import { WithSession } from '../session.tsx';

describe('Add a PostgreSQL source', () => {
  it('sends settings and credentials once, and never keeps the password', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => [],
      'POST /workspaces/w1/sources': () =>
        reply(400, {
          title: 'Private and local network addresses are not allowed here.',
          status: 400,
          code: 'invalid_destination',
        }),
    });
    render(
      <WithSession>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </WithSession>,
    );
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    await user.click(screen.getByRole('radio', { name: 'PostgreSQL database (read-only)' }));
    await user.type(screen.getByLabelText('Name'), 'Warehouse');
    await user.type(screen.getByLabelText('Host'), '10.0.0.5');
    await user.type(screen.getByLabelText('Database'), 'analytics');
    await user.type(screen.getByLabelText('Username'), 'ds_reader');
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    await user.type(password, 'S3cret');
    await user.click(screen.getByRole('button', { name: 'Add PostgreSQL source' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Private and local network');
    expect(calls.find((c) => c.key === 'POST /workspaces/w1/sources')?.body).toEqual({
      type: 'postgres',
      name: 'Warehouse',
      settings: { host: '10.0.0.5', port: 5432, database: 'analytics', sslMode: 'verify-full' },
      credentials: { username: 'ds_reader', password: 'S3cret' },
    });
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('tests a database connection and shows the safe result', async () => {
    const user = userEvent.setup();
    const pg = {
      id: 's7',
      name: 'Warehouse',
      type: 'postgres',
      status: 'active',
      ownerName: null,
      datasetCount: 0,
      lastCheckedAt: null,
    };
    const test = {
      id: 't1',
      sourceId: 's7',
      serverVersion: null,
      latencyMs: null,
      error: null,
      createdAt: '2026-10-17T10:00:00.000Z',
      finishedAt: null,
    };
    routeApi({
      'GET /workspaces/w1/sources': () => [pg],
      'POST /workspaces/w1/sources/s7/connection-tests': () =>
        reply(202, { ...test, status: 'queued' }),
      'GET /workspaces/w1/connection-tests/t1': () => ({
        ...test,
        status: 'failed',
        error: {
          code: 'auth_failed',
          message: 'The source rejected the username or password.',
          hint: 'Check the credentials, or rotate them in the source settings.',
          retryable: false,
        },
      }),
    });
    render(
      <WithSession>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </WithSession>,
    );
    await user.click(await screen.findByRole('button', { name: 'Test connection to Warehouse' }));
    expect(
      await screen.findByText(
        'The source rejected the username or password.',
        {},
        { timeout: 3000 },
      ),
    ).toBeVisible();
  });

  it('registers a discovered table and opens the new dataset', async () => {
    const user = userEvent.setup();
    const pg = {
      id: 's7',
      name: 'Warehouse',
      type: 'postgres',
      status: 'active',
      ownerName: null,
      datasetCount: 0,
      lastCheckedAt: null,
    };
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => [pg],
      'POST /workspaces/w1/sources/s7/discoveries': () => ({
        tables: [
          { schema: 'public', name: 'customers', kind: 'table', estimatedRows: 120 },
          { schema: 'sales', name: 'orders', kind: 'view', estimatedRows: null },
        ],
        truncated: false,
      }),
      'POST /workspaces/w1/datasets': () => reply(201, { id: 'd5' }),
    });
    render(
      <WithSession>
        <MemoryRouter initialEntries={['/sources']}>
          <Routes>
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/datasets/:id" element={<p>Dataset page</p>} />
          </Routes>
        </MemoryRouter>
      </WithSession>,
    );
    await user.click(await screen.findByRole('button', { name: 'Add a dataset from Warehouse' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a dataset from Warehouse' });
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find a table' }), 'order');
    expect(within(dialog).queryByText('public.customers')).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: /sales\.orders/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Register dataset' }));
    expect(await screen.findByText('Dataset page')).toBeVisible();
    expect(calls.find((c) => c.key === 'POST /workspaces/w1/datasets')?.body).toEqual({
      sourceId: 's7',
      schema: 'sales',
      table: 'orders',
    });
  });

  it('replaces a database login without prefilling or keeping it', async () => {
    const user = userEvent.setup();
    const pg = {
      id: 's7',
      name: 'Warehouse',
      type: 'postgres',
      status: 'active',
      ownerName: null,
      datasetCount: 0,
      lastCheckedAt: null,
    };
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => [pg],
      'POST /workspaces/w1/sources/s7/credentials/rotate': () => ({ ...pg, hasCredential: true }),
    });
    render(
      <WithSession>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </WithSession>,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Replace the login for Warehouse' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Replace the login for Warehouse' });
    expect(within(dialog).getByLabelText('Username')).toHaveValue('');
    await user.type(within(dialog).getByLabelText('Username'), 'reader2');
    await user.type(within(dialog).getByLabelText('New password'), 'N3w');
    await user.click(within(dialog).getByRole('button', { name: 'Replace login' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      calls.find((c) => c.key === 'POST /workspaces/w1/sources/s7/credentials/rotate')?.body,
    ).toEqual({ username: 'reader2', password: 'N3w' });
  });
});
