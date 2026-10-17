import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { DatasetDetailPage } from '../../src/pages/DatasetDetailPage.tsx';
import { SourcesPage } from '../../src/pages/SourcesPage.tsx';
import { hashFile } from '../../src/uploads/hashFile.ts';
import { UploadCsvDialog } from '../../src/uploads/UploadCsvDialog.tsx';
import { reply, routeApi } from '../api.ts';
import { fakeSession, signedIn, WithSession } from '../session.tsx';

const csvSource = {
  id: 's1',
  name: 'Finance exports',
  type: 'csv',
  status: 'active',
  ownerName: null,
  datasetCount: 1,
  lastCheckedAt: null,
};

const upload = (fields: Record<string, unknown>) => ({
  id: 'u1',
  sourceId: 's1',
  datasetId: 'd9',
  newDatasetName: null,
  filename: 'sales.csv',
  sizeBytes: 20,
  status: 'queued',
  error: null,
  rowCount: null,
  columnCount: null,
  createdAt: '2026-10-17T09:00:00.000Z',
  completedAt: null,
  ...fields,
});

const instructions = {
  method: 'PUT',
  url: 'http://storage.test/obj',
  headers: {},
  expiresAt: '2026-10-17T09:15:00.000Z',
};

function renderDialog(putFile = vi.fn(() => Promise.resolve())) {
  const onUploaded = vi.fn();
  render(
    <MemoryRouter>
      <UploadCsvDialog
        workspaceId="w1"
        onClose={() => {}}
        onUploaded={onUploaded}
        putFile={putFile}
      />
    </MemoryRouter>,
  );
  return { putFile, onUploaded };
}

const csv = new File(['id,name\n1,Ada\n'], 'sales.csv', { type: 'text/csv' });

describe('hashFile', () => {
  it('gives the SHA-256 of the file in hex', async () => {
    expect(await hashFile(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('Upload CSV dialog', () => {
  it('hashes, sends, completes, and follows the check to its result', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => [csvSource],
      'GET /workspaces/w1/datasets': () => [],
      'POST /workspaces/w1/sources/s1/uploads': () =>
        reply(201, { upload: upload({ status: 'awaiting_upload' }), instructions }),
      'POST /workspaces/w1/uploads/u1/complete': () => reply(202, upload({ status: 'queued' })),
      'GET /workspaces/w1/uploads/u1': () =>
        upload({ status: 'succeeded', rowCount: 1, columnCount: 2 }),
    });
    const { putFile, onUploaded } = renderDialog();

    const dialog = await screen.findByRole('dialog', { name: 'Upload a CSV file' });
    expect(await within(dialog).findByRole('option', { name: 'Finance exports' })).toBeTruthy();
    await user.type(within(dialog).getByLabelText('New dataset name'), 'Daily sales');
    await user.upload(within(dialog).getByLabelText('File'), csv);
    await user.click(within(dialog).getByRole('button', { name: 'Upload file' }));

    expect(
      await within(dialog).findByText(/Checked 1 row and 2 columns/, {}, { timeout: 3000 }),
    ).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'Open the dataset' })).toHaveAttribute(
      'href',
      '/datasets/d9',
    );
    const started = calls.find((c) => c.key === 'POST /workspaces/w1/sources/s1/uploads');
    expect(started?.body).toEqual({
      filename: 'sales.csv',
      sizeBytes: csv.size,
      checksumSha256: await hashFile(csv),
      newDatasetName: 'Daily sales',
    });
    expect(putFile).toHaveBeenCalledWith(
      instructions,
      csv,
      expect.any(Function),
      expect.anything(),
    );
    expect(onUploaded).toHaveBeenCalled();
    const steps = within(dialog).getByRole('list', { name: 'Upload progress' });
    expect(within(steps).getAllByText('Done')).toHaveLength(3);
  });

  it('shows why the file was rejected, with the hint', async () => {
    const user = userEvent.setup();
    routeApi({
      'GET /workspaces/w1/sources': () => [csvSource],
      'GET /workspaces/w1/datasets': () => [],
      'POST /workspaces/w1/sources/s1/uploads': () =>
        reply(201, { upload: upload({}), instructions }),
      'POST /workspaces/w1/uploads/u1/complete': () =>
        reply(
          202,
          upload({
            status: 'failed',
            error: {
              code: 'malformed',
              message: 'Line 3 has 1 value; the header has 2.',
              hint: 'Fix the file and upload it again.',
              retryable: false,
            },
          }),
        ),
    });
    const { onUploaded } = renderDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Finance exports' });
    await user.type(within(dialog).getByLabelText('New dataset name'), 'Sales');
    await user.upload(within(dialog).getByLabelText('File'), csv);
    await user.click(within(dialog).getByRole('button', { name: 'Upload file' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Line 3 has 1 value; the header has 2.');
    expect(alert).toHaveTextContent('Fix the file and upload it again.');
    expect(within(dialog).getByText('Failed')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Upload again' })).toBeEnabled();
    // The failed upload is listed too, so the page reloads.
    expect(onUploaded).toHaveBeenCalled();
  });

  it('refuses a file over 50 MB before sending anything', async () => {
    const user = userEvent.setup();
    const calls = routeApi({
      'GET /workspaces/w1/sources': () => [csvSource],
      'GET /workspaces/w1/datasets': () => [],
    });
    const { putFile } = renderDialog();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Finance exports' });
    const big = new File(['x'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    await user.type(within(dialog).getByLabelText('New dataset name'), 'Big');
    await user.upload(within(dialog).getByLabelText('File'), big);
    await user.click(within(dialog).getByRole('button', { name: 'Upload file' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('larger than 50 MB');
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
    expect(putFile).not.toHaveBeenCalled();
  });

  it('points to the Sources page when there is no CSV source', async () => {
    routeApi({
      'GET /workspaces/w1/sources': () => [{ ...csvSource, type: 'postgres' }],
      'GET /workspaces/w1/datasets': () => [],
    });
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('link', { name: 'Add a CSV source' })).toHaveAttribute(
      'href',
      '/sources',
    );
  });
});

const profile = {
  id: 'p1',
  status: 'succeeded',
  observedAt: '2026-10-17T09:01:00.000Z',
  rowCount: 4,
  lastUpdatedAt: '2026-10-17T09:00:00.000Z',
  error: null,
  columns: [
    { name: 'id', type: 'integer', nullCount: 0, ordinal: 1 },
    { name: 'note', type: 'text', nullCount: 1, ordinal: 2 },
  ],
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
  latestProfile: profile,
  lastSuccessfulProfile: profile,
};

function renderDatasetPage(children: ReactNode = <DatasetDetailPage />) {
  render(
    <WithSession>
      <MemoryRouter initialEntries={['/datasets/d9']}>
        <Routes>
          <Route path="/datasets/:datasetId" element={children} />
        </Routes>
      </MemoryRouter>
    </WithSession>,
  );
}

describe('Dataset page', () => {
  it('shows the latest profile and the uploads with their problems', async () => {
    routeApi({
      'GET /workspaces/w1/datasets/d9': () => dataset,
      'GET /workspaces/w1/datasets/d9/rules': () => [],
      'GET /workspaces/w1/datasets/d9/profiles': () => [],
      'GET /workspaces/w1/uploads?datasetId=d9': () => [
        upload({
          id: 'u2',
          filename: 'broken.csv',
          status: 'failed',
          error: {
            code: 'malformed',
            message: 'Line 3 has 1 value; the header has 2.',
            hint: 'Fix the file and upload it again.',
            retryable: false,
          },
        }),
        upload({ status: 'succeeded', rowCount: 4, columnCount: 2 }),
      ],
    });
    renderDatasetPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Daily sales' })).toBeVisible();
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Rows').nextSibling).toHaveTextContent('4');

    const columns = screen.getByRole('table', { name: 'Columns in the latest profile' });
    expect(within(columns).getByText('Whole number')).toBeVisible();
    expect(within(columns).getByText('1 (25%)')).toBeVisible();

    const uploads = await screen.findByRole('table', { name: 'Recent uploads' });
    expect(within(uploads).getByText('broken.csv')).toBeVisible();
    expect(within(uploads).getByText('Failed')).toBeVisible();
    expect(within(uploads).getByText('Line 3 has 1 value; the header has 2.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload CSV' })).toBeVisible();
  });

  const failedProfile = {
    ...profile,
    id: 'p2',
    status: 'failed',
    observedAt: '2026-10-17T10:00:00.000Z',
    rowCount: null,
    columns: [],
    error: {
      code: 'too_large',
      message: 'Line 9 is longer than the 1 MB row limit.',
      hint: 'Fix the file and upload it again.',
      retryable: false,
    },
  };

  it('shows a failed first profile as a failure, never as zero rows', async () => {
    routeApi({
      'GET /workspaces/w1/datasets/d9': () => ({
        ...dataset,
        latestProfile: failedProfile,
        lastSuccessfulProfile: null,
      }),
      'GET /workspaces/w1/datasets/d9/rules': () => [],
      'GET /workspaces/w1/datasets/d9/profiles': () => [],
      'GET /workspaces/w1/uploads?datasetId=d9': () => [],
    });
    renderDatasetPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The latest profile failed');
    expect(alert).toHaveTextContent('Line 9 is longer than the 1 MB row limit.');
    expect(
      within(screen.getByRole('region', { name: 'Summary' })).getAllByText('Not profiled'),
    ).toHaveLength(2);
    expect(screen.queryByRole('table', { name: /Columns/ })).toBeNull();
  });

  it('keeps the last good profile in view after a failed one', async () => {
    routeApi({
      'GET /workspaces/w1/datasets/d9': () => ({ ...dataset, latestProfile: failedProfile }),
      'GET /workspaces/w1/datasets/d9/rules': () => [],
      'GET /workspaces/w1/datasets/d9/profiles': () => [],
      'GET /workspaces/w1/uploads?datasetId=d9': () => [],
    });
    renderDatasetPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Below is the last successful profile');
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Rows').nextSibling).toHaveTextContent('4');
    const columns = screen.getByRole('table', { name: 'Columns in the last successful profile' });
    expect(within(columns).getByText('Whole number')).toBeVisible();
  });

  it('says so when the dataset does not exist', async () => {
    routeApi({
      'GET /workspaces/w1/datasets/d9': () =>
        reply(404, { title: 'Dataset not found.', status: 404, code: 'dataset_not_found' }),
      'GET /workspaces/w1/datasets/d9/rules': () => [],
      'GET /workspaces/w1/datasets/d9/profiles': () => [],
      'GET /workspaces/w1/uploads?datasetId=d9': () => [],
    });
    renderDatasetPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Dataset not found');
  });
});

describe('Add CSV source', () => {
  it('lets a data engineer add one, then shows it', async () => {
    const user = userEvent.setup();
    const added = { ...csvSource, id: 's2', name: 'Exports' };
    const calls = routeApi({
      'GET /workspaces/w1/sources': [() => [], () => [added]],
      'POST /workspaces/w1/sources': () => reply(201, added),
    });
    render(
      <WithSession>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </WithSession>,
    );
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    await user.type(screen.getByLabelText('Name'), 'Exports');
    await user.click(screen.getByRole('button', { name: 'Add CSV source' }));
    expect(await screen.findByText('Exports')).toBeVisible();
    expect(calls.find((c) => c.key === 'POST /workspaces/w1/sources')?.body).toEqual({
      name: 'Exports',
      type: 'csv',
    });
  });

  it('is not offered to analysts', async () => {
    routeApi({ 'GET /workspaces/w1/sources': () => [] });
    render(
      <WithSession session={fakeSession(signedIn('analyst'))}>
        <MemoryRouter>
          <SourcesPage />
        </MemoryRouter>
      </WithSession>,
    );
    await screen.findByRole('heading', { name: 'No data sources yet' });
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeNull();
  });
});

describe('Accessibility of the upload screens', () => {
  async function violations(): Promise<string[]> {
    document.documentElement.lang = 'en';
    const result = await axe.run(document, { rules: { 'color-contrast': { enabled: false } } });
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
  }

  it('dataset page has no automatically detectable problems', async () => {
    routeApi({
      'GET /workspaces/w1/datasets/d9': () => dataset,
      'GET /workspaces/w1/datasets/d9/rules': () => [],
      'GET /workspaces/w1/datasets/d9/profiles': () => [],
      'GET /workspaces/w1/uploads?datasetId=d9': () => [
        upload({ status: 'succeeded', rowCount: 4 }),
      ],
    });
    renderDatasetPage();
    await screen.findByRole('table', { name: 'Recent uploads' });
    expect(await violations()).toEqual([]);
  });

  it('upload dialog has no automatically detectable problems', async () => {
    routeApi({
      'GET /workspaces/w1/sources': () => [csvSource],
      'GET /workspaces/w1/datasets': () => [],
    });
    // Rendered alone, without the page that gives the document its title.
    document.title = 'Datasets – DataSentinel';
    renderDialog();
    await screen.findByRole('option', { name: 'Finance exports' });
    expect(await violations()).toEqual([]);
  });
});
