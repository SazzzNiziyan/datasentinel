import {
  documentFormatFor,
  type DocumentHit,
  type DocumentSummary,
  type Role,
} from '@datasentinel/contracts';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { formatTime } from '../format.ts';
import { canComment, canEdit } from '../pages/labels.ts';
import './DestinationsPanel.css';

const MAX_FILE_BYTES = 1024 * 1024;

const problemText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? (caught.detail ?? caught.message) : fallback;

/** Pipeline documents: notes and runbooks stored as plain text. Everything
 * shown here, including search snippets, is rendered as text, never as markup
 * or links. The API enforces the roles too. */
export function DocumentsPanel({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const base = `/workspaces/${workspaceId}/documents`;
  const list = useApiData<DocumentSummary[]>(base);
  const [archiving, setArchiving] = useState<DocumentSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocumentHit[] | undefined>();
  const [searchError, setSearchError] = useState<string | undefined>();

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    setError(undefined);
    setNotice(undefined);
    if (file === undefined) return;
    try {
      if (documentFormatFor(file.name) === null) {
        setError('Only .txt and .md files are supported.');
      } else if (file.size > MAX_FILE_BYTES) {
        setError('That file is too large.');
      } else {
        const content = await file.text();
        await apiFetch(base, {
          method: 'POST',
          body: JSON.stringify({ name: file.name, content }),
        });
        setNotice('Document added.');
        list.retry();
      }
    } catch (caught) {
      setError(problemText(caught, 'The document was not added.'));
    }
    input.value = '';
  }

  async function confirmArchive() {
    if (archiving === undefined) return;
    setError(undefined);
    setNotice(undefined);
    try {
      await apiFetch(`${base}/${archiving.id}`, { method: 'DELETE' });
    } catch (caught) {
      setError(problemText(caught, 'The document was not archived.'));
    }
    setArchiving(undefined);
    list.retry();
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q === '') return;
    setSearchError(undefined);
    try {
      setHits(await apiFetch<DocumentHit[]>(`${base}/search?q=${encodeURIComponent(q)}`));
    } catch (caught) {
      setHits(undefined);
      setSearchError(problemText(caught, 'The search failed.'));
    }
  }

  const columns: Column<DocumentSummary>[] = [
    { key: 'name', header: 'Name', cell: (d) => d.name },
    { key: 'type', header: 'Type', cell: (d) => (d.format === 'markdown' ? 'Markdown' : 'Text') },
    { key: 'size', header: 'Size', cell: (d) => `${d.sizeChars} characters` },
    { key: 'sections', header: 'Sections', cell: (d) => `${d.chunkCount} parts` },
    { key: 'added', header: 'Added', cell: (d) => formatTime(d.createdAt) },
    {
      key: 'actions',
      header: 'Actions',
      cell: (d) =>
        canEdit(role) ? (
          <button
            type="button"
            className="button"
            aria-label={`Archive ${d.name}`}
            onClick={() => setArchiving(d)}
          >
            Archive
          </button>
        ) : null,
    },
  ];

  return (
    <section className="panel" aria-labelledby="documents-title">
      <h2 id="documents-title" className="panel__title">
        Pipeline documents
      </h2>
      <p>
        Notes and runbooks about your pipelines. They are read as plain text and used to explain
        incidents. Only .txt and .md files are supported; nothing in a document is ever opened as a
        link or run.
      </p>
      {list.status === 'error' ? (
        <ErrorState
          title="Could not load documents"
          description={list.error.detail ?? list.error.message}
          onRetry={list.retry}
          retrying={list.retrying}
        />
      ) : (
        <DataTable
          caption="Documents"
          columns={columns}
          rows={list.status === 'ready' ? list.data : []}
          rowKey={(d) => d.id}
          status={list.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No documents yet"
              description="Add a runbook or notes about a pipeline."
            />
          }
        />
      )}
      {error !== undefined && (
        <p role="alert" className="destinations__error">
          {error}
        </p>
      )}
      {notice !== undefined && <p role="status">{notice}</p>}
      {canEdit(role) && (
        <div className="destinations__form">
          <label className="destinations__field">
            Add a document (.txt or .md)
            <input
              type="file"
              className="text-input"
              accept=".txt,.md,.markdown"
              onChange={(e) => void upload(e)}
            />
          </label>
        </div>
      )}
      {canComment(role) && (
        <>
          <form className="destinations__form" onSubmit={(e) => void search(e)}>
            <label className="destinations__field">
              Search the documents
              <input
                type="search"
                className="text-input"
                maxLength={200}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="destinations__actions">
              <button
                type="submit"
                className="button button--primary"
                disabled={query.trim() === ''}
              >
                Search
              </button>
            </div>
          </form>
          {searchError !== undefined && (
            <p role="alert" className="destinations__error">
              {searchError}
            </p>
          )}
          {hits !== undefined &&
            (hits.length === 0 ? (
              <p>No matches.</p>
            ) : (
              <ul aria-label="Search results">
                {hits.map((h) => (
                  <li key={h.chunkId}>
                    <strong>{h.documentName}</strong>
                    {' · '}
                    {h.sectionPath ?? 'No section'}
                    {' · '}
                    {`lines ${h.startLine}-${h.endLine}`}
                    <p>{h.snippet}</p>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
      {archiving !== undefined && (
        <ConfirmActionDialog
          open
          title="Archive this document?"
          target={archiving.name}
          effect="It is removed from search and can no longer be used to explain incidents. You can add it again later."
          confirmLabel="Archive document"
          onConfirm={confirmArchive}
          onCancel={() => setArchiving(undefined)}
        />
      )}
    </section>
  );
}
