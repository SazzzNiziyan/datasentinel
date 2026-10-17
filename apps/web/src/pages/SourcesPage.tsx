import type { SourceSummary } from '@datasentinel/contracts';
import { useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { canEdit, lifecycleLabel, sourceTypeLabel } from './labels.ts';
import './SourcesPage.css';

const lastChecked = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const columns: Column<SourceSummary>[] = [
  { key: 'name', header: 'Source', cell: (s) => s.name, sortValue: (s) => s.name },
  {
    key: 'type',
    header: 'Type',
    cell: (s) => sourceTypeLabel[s.type],
    sortValue: (s) => sourceTypeLabel[s.type],
  },
  { key: 'status', header: 'Status', cell: (s) => lifecycleLabel[s.status] },
  { key: 'owner', header: 'Owner', cell: (s) => s.ownerName ?? 'No owner' },
  {
    key: 'datasets',
    header: 'Datasets',
    cell: (s) => s.datasetCount,
    sortValue: (s) => s.datasetCount,
    numeric: true,
  },
  {
    key: 'lastCheck',
    header: 'Last check',
    cell: (s) =>
      s.lastCheckedAt === null
        ? 'Not checked yet'
        : `${lastChecked.format(new Date(s.lastCheckedAt))} UTC`,
  },
];

/** Names a new CSV source (D-44). PostgreSQL waits for its connector. */
function AddCsvSource({ workspaceId, onAdded }: { workspaceId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || name.trim() === '') return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/sources`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), type: 'csv' }),
      });
      setName('');
      setOpen(false);
      onAdded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The source could not be added.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="page-actions">
        <button type="button" className="button button--primary" onClick={() => setOpen(true)}>
          Add CSV source
        </button>
      </div>
    );
  }
  return (
    <section className="add-source" aria-labelledby="add-source-title">
      <h2 id="add-source-title" className="add-source__title">
        Add a CSV source
      </h2>
      <p className="add-source__help">
        A CSV source holds uploaded files. Upload files to it from Datasets. PostgreSQL connections
        arrive with the next release step.
      </p>
      <form className="add-source__form" onSubmit={(e) => void submit(e)}>
        <label className="add-source__field">
          Name
          <input
            className="text-input"
            maxLength={80}
            placeholder="For example, Finance exports"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit" className="button button--primary" disabled={saving}>
          Add source
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </form>
      {error !== null && (
        <p role="alert" className="add-source__error">
          {error}
        </p>
      )}
    </section>
  );
}

/** The workspace's data sources, from the API (D-39). */
export function SourcesPage() {
  const { workspace } = useSignedIn();
  const sources = useApiData<SourceSummary[]>(`/workspaces/${workspace?.workspaceId}/sources`);

  return (
    <PageFrame
      title="Data sources"
      summary="CSV uploads, PostgreSQL connections, and API checks, with their health."
    >
      {workspace !== undefined && canEdit(workspace.role) && (
        <AddCsvSource workspaceId={workspace.workspaceId} onAdded={sources.retry} />
      )}
      {sources.status === 'error' ? (
        <ErrorState
          title="Could not load data sources"
          description={sources.error.detail ?? sources.error.message}
          onRetry={sources.retry}
          retrying={sources.retrying}
        />
      ) : (
        <DataTable
          caption="Data sources"
          columns={columns}
          rows={sources.status === 'ready' ? sources.data : []}
          rowKey={(s) => s.id}
          status={sources.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No data sources yet"
              description="Checks run against a data source. Add a CSV source to upload files; PostgreSQL connections arrive with the next steps of this release."
            />
          }
        />
      )}
    </PageFrame>
  );
}
