import type { DocumentHit, DocumentSummary, Role } from '@datasentinel/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentsPanel } from '../../src/settings/DocumentsPanel.tsx';
import { reply, routeApi } from '../api.ts';

afterEach(() => vi.unstubAllGlobals());

const BASE = '/workspaces/w1/documents';
const LIST = `GET ${BASE}`;

const doc = (over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: 'd1',
  name: 'runbook.md',
  format: 'markdown',
  sizeChars: 1200,
  chunkCount: 3,
  sourceId: null,
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

const hit = (over: Partial<DocumentHit> = {}): DocumentHit => ({
  chunkId: 'c1',
  documentId: 'd1',
  documentName: 'runbook.md',
  sectionPath: 'Recovery > Restart',
  startLine: 4,
  endLine: 9,
  snippet: 'Restart the <b>x</b> job',
  rank: 1,
  ...over,
});

const renderPanel = (role: Role = 'engineer') =>
  render(<DocumentsPanel workspaceId="w1" role={role} />);

const user = () => userEvent.setup();
const fileInput = () => screen.getByLabelText('Add a document (.txt or .md)');

describe('Pipeline documents', () => {
  it('lists documents', async () => {
    routeApi({ [LIST]: () => [doc(), doc({ id: 'd2', name: 'notes.txt', format: 'text' })] });
    renderPanel();
    await screen.findByText('runbook.md');
    const rows = within(screen.getByRole('table', { name: 'Documents' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows[0]).toHaveTextContent('Markdown');
    expect(rows[0]).toHaveTextContent('1200 characters');
    expect(rows[0]).toHaveTextContent('3 parts');
    expect(rows[1]).toHaveTextContent('Text');
  });

  it('shows an empty state', async () => {
    routeApi({ [LIST]: () => [] });
    renderPanel();
    expect(await screen.findByText('No documents yet')).toBeVisible();
  });

  it('shows the list only to a viewer', async () => {
    routeApi({ [LIST]: () => [doc()] });
    renderPanel('viewer');
    await screen.findByText('runbook.md');
    expect(screen.queryByLabelText('Add a document (.txt or .md)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive runbook.md' })).toBeNull();
    expect(screen.queryByLabelText('Search the documents')).toBeNull();
  });

  it('gives an analyst search but not upload or archive', async () => {
    routeApi({ [LIST]: () => [doc()] });
    renderPanel('analyst');
    await screen.findByText('runbook.md');
    expect(screen.getByLabelText('Search the documents')).toBeVisible();
    expect(screen.queryByLabelText('Add a document (.txt or .md)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive runbook.md' })).toBeNull();
  });

  it('gives an engineer everything', async () => {
    routeApi({ [LIST]: () => [doc()] });
    renderPanel('engineer');
    await screen.findByText('runbook.md');
    expect(fileInput()).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive runbook.md' })).toBeVisible();
    expect(screen.getByLabelText('Search the documents')).toBeVisible();
  });

  it('rejects an unsupported name without a request', async () => {
    const calls = routeApi({ [LIST]: () => [] });
    renderPanel();
    await screen.findByText('No documents yet');
    const u = userEvent.setup({ applyAccept: false });
    await u.upload(fileInput(), new File(['x'], 'data.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only .txt and .md files are supported.',
    );
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('rejects a file over 1 MB without a request', async () => {
    const calls = routeApi({ [LIST]: () => [] });
    renderPanel();
    await screen.findByText('No documents yet');
    const big = new File([new Uint8Array(1024 * 1024 + 1)], 'big.txt', { type: 'text/plain' });
    await user().upload(fileInput(), big);
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is too large.');
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('uploads a markdown file and reloads', async () => {
    const calls = routeApi({
      [LIST]: () => [],
      [`POST ${BASE}`]: () => reply(201, doc()),
    });
    renderPanel();
    await screen.findByText('No documents yet');
    await user().upload(
      fileInput(),
      new File(['# Hi\nbody'], 'runbook.md', { type: 'text/markdown' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Document added.');
    expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
      name: 'runbook.md',
      content: '# Hi\nbody',
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.key === LIST)).toHaveLength(2));
  });

  it('shows the server reason when an upload fails', async () => {
    routeApi({
      [LIST]: () => [],
      [`POST ${BASE}`]: () =>
        reply(409, {
          code: 'document_exists',
          title: 'Conflict',
          detail: 'This document is already stored.',
        }),
    });
    renderPanel();
    await screen.findByText('No documents yet');
    await user().upload(fileInput(), new File(['abc'], 'a.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This document is already stored.');
  });

  it('searches and shows a snippet as literal text', async () => {
    const calls = routeApi({
      [LIST]: () => [],
      [`GET ${BASE}/search?q=restart%20job`]: () => [hit()],
    });
    renderPanel('analyst');
    await screen.findByText('No documents yet');
    const u = user();
    const search = screen.getByRole('button', { name: 'Search' });
    expect(search).toBeDisabled();
    await u.type(screen.getByLabelText('Search the documents'), 'restart job{Enter}');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(results).toHaveTextContent('runbook.md');
    expect(results).toHaveTextContent('Recovery > Restart');
    expect(results).toHaveTextContent('lines 4-9');
    expect(results).toHaveTextContent('Restart the <b>x</b> job');
    expect(results.querySelector('b')).toBeNull();
    expect(calls.some((c) => c.key === `GET ${BASE}/search?q=restart%20job`)).toBe(true);
  });

  it('says when nothing matches', async () => {
    routeApi({ [LIST]: () => [], [`GET ${BASE}/search?q=zzz`]: () => [] });
    renderPanel('analyst');
    await screen.findByText('No documents yet');
    const u = user();
    await u.type(screen.getByLabelText('Search the documents'), 'zzz');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No matches.')).toBeVisible();
  });

  it('archives only after confirming, then reloads', async () => {
    const calls = routeApi({
      [LIST]: () => [doc()],
      [`DELETE ${BASE}/d1`]: () => reply(204, undefined),
    });
    renderPanel();
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Archive runbook.md' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this document?' });
    expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
    await u.click(within(dialog).getByRole('button', { name: 'Archive document' }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === `DELETE ${BASE}/d1`)).toBe(true));
    await vi.waitFor(() => expect(calls.filter((c) => c.key === LIST)).toHaveLength(2));
  });
});
