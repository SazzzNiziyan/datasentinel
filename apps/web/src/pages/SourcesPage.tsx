import type { SourceSummary } from '@datasentinel/contracts';
import { useState } from 'react';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { canEdit, lifecycleLabel, sourceTypeLabel } from './labels.ts';
import { AddSource } from './AddSource.tsx';
import { LifecycleActions } from './LifecycleActions.tsx';
import { RegisterTableDialog } from './RegisterTableDialog.tsx';
import { RotateLoginDialog } from './RotateLoginDialog.tsx';
import { TestConnection } from './TestConnection.tsx';
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

/** The workspace's data sources, from the API (D-39). */
export function SourcesPage() {
  const { workspace } = useSignedIn();
  const [showArchived, setShowArchived] = useState(false);
  const [registering, setRegistering] = useState<SourceSummary | null>(null);
  const [rotating, setRotating] = useState<SourceSummary | null>(null);
  const sources = useApiData<SourceSummary[]>(
    `/workspaces/${workspace?.workspaceId}/sources${showArchived ? '?status=archived' : ''}`,
  );
  const reload = sources.retry;
  const withActions: Column<SourceSummary>[] =
    workspace !== undefined && canEdit(workspace.role) && !showArchived
      ? [
          ...columns,
          {
            key: 'actions',
            header: 'Actions',
            cell: (s) => (
              <div className="source-actions">
                {s.type === 'postgres' && s.status !== 'archived' && (
                  <button
                    type="button"
                    className="button source-actions__add"
                    aria-label={`Add a dataset from ${s.name}`}
                    onClick={() => setRegistering(s)}
                  >
                    Add dataset
                  </button>
                )}
                {s.type === 'postgres' && s.status !== 'archived' && (
                  <button
                    type="button"
                    className="button source-actions__add"
                    aria-label={`Replace the login for ${s.name}`}
                    onClick={() => setRotating(s)}
                  >
                    Replace login
                  </button>
                )}
                {s.type === 'postgres' && s.status !== 'archived' && (
                  <TestConnection
                    workspaceId={workspace.workspaceId}
                    sourceId={s.id}
                    name={s.name}
                    onFinished={reload}
                  />
                )}
                <LifecycleActions
                  kind="source"
                  workspaceId={workspace.workspaceId}
                  id={s.id}
                  name={s.name}
                  status={s.status}
                  role={workspace.role}
                  onChanged={reload}
                />
              </div>
            ),
          },
        ]
      : columns;

  return (
    <PageFrame
      title="Data sources"
      summary="CSV uploads, PostgreSQL connections, and API checks, with their health."
    >
      {workspace !== undefined && canEdit(workspace.role) && (
        <AddSource workspaceId={workspace.workspaceId} onAdded={sources.retry} />
      )}
      <div className="sources-filter">
        <button
          type="button"
          className="button"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          Show archived sources
        </button>
      </div>
      {sources.status === 'error' ? (
        <ErrorState
          title="Could not load data sources"
          description={sources.error.detail ?? sources.error.message}
          onRetry={sources.retry}
          retrying={sources.retrying}
        />
      ) : (
        <DataTable
          caption={showArchived ? 'Archived data sources' : 'Data sources'}
          columns={withActions}
          rows={sources.status === 'ready' ? sources.data : []}
          rowKey={(s) => s.id}
          status={sources.status === 'loading' ? 'loading' : 'ready'}
          empty={
            showArchived ? (
              <EmptyState
                title="No archived sources"
                description="Archived sources and their history appear here."
              />
            ) : (
              <EmptyState
                title="No data sources yet"
                description="Checks run against a data source. Add a CSV source to upload files, or a read-only PostgreSQL database."
              />
            )
          }
        />
      )}
      {rotating !== null && workspace !== undefined && (
        <RotateLoginDialog
          workspaceId={workspace.workspaceId}
          sourceId={rotating.id}
          sourceName={rotating.name}
          onClose={() => setRotating(null)}
          onRotated={sources.retry}
        />
      )}
      {registering !== null && workspace !== undefined && (
        <RegisterTableDialog
          workspaceId={workspace.workspaceId}
          sourceId={registering.id}
          sourceName={registering.name}
          onClose={() => setRegistering(null)}
        />
      )}
    </PageFrame>
  );
}
