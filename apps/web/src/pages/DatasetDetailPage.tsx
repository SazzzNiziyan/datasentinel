import type {
  DatasetDetail,
  ProfileColumn,
  UploadDetail,
  UploadStatus,
} from '@datasentinel/contracts';
import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { StatusMark, type Tone } from '../components/StatusMark.tsx';
import { UploadCsvDialog } from '../uploads/UploadCsvDialog.tsx';
import { canEdit, columnTypeLabel } from './labels.ts';
import './DatasetDetailPage.css';

const when = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const at = (iso: string | null) => (iso === null ? 'Never' : `${when.format(new Date(iso))} UTC`);
const count = (n: number) => n.toLocaleString('en-US');

const uploadMark: Record<UploadStatus, { tone: Tone; label: string }> = {
  awaiting_upload: { tone: 'neutral', label: 'Not sent' },
  queued: { tone: 'info', label: 'Waiting to check' },
  parsing: { tone: 'info', label: 'Checking' },
  succeeded: { tone: 'healthy', label: 'Checked' },
  failed: { tone: 'critical', label: 'Failed' },
};

const bytes = (n: number) =>
  n < 1024 * 1024 ? `${count(Math.ceil(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function profileColumns(rowCount: number): Column<ProfileColumn>[] {
  return [
    {
      key: 'ordinal',
      header: 'Position',
      cell: (c) => c.ordinal,
      sortValue: (c) => c.ordinal,
      numeric: true,
    },
    {
      key: 'name',
      header: 'Column',
      cell: (c) => <span className="mono">{c.name}</span>,
      sortValue: (c) => c.name,
    },
    { key: 'type', header: 'Type', cell: (c) => columnTypeLabel(c.type), sortValue: (c) => c.type },
    {
      key: 'nulls',
      header: 'Empty values',
      cell: (c) =>
        rowCount === 0
          ? count(c.nullCount)
          : `${count(c.nullCount)} (${Math.round((c.nullCount / rowCount) * 1000) / 10}%)`,
      sortValue: (c) => c.nullCount,
      numeric: true,
    },
  ];
}

const uploadColumns: Column<UploadDetail>[] = [
  { key: 'file', header: 'File', cell: (u) => u.filename },
  {
    key: 'status',
    header: 'Status',
    cell: (u) => <StatusMark {...uploadMark[u.status]} />,
  },
  {
    key: 'rows',
    header: 'Rows',
    cell: (u) => (u.rowCount === null ? 'None' : count(u.rowCount)),
    numeric: true,
  },
  { key: 'size', header: 'Size', cell: (u) => bytes(u.sizeBytes), numeric: true },
  { key: 'uploaded', header: 'Uploaded', cell: (u) => at(u.createdAt) },
  {
    key: 'problem',
    header: 'Problem',
    cell: (u) =>
      u.error === null ? (
        'None'
      ) : (
        <span className="dataset-uploads__problem">
          <span>{u.error.message}</span>
          <span className="dataset-uploads__hint">{u.error.hint}</span>
        </span>
      ),
  },
];

/** One dataset: its latest profile and the files uploaded to it (D-44). */
export function DatasetDetailPage() {
  const { datasetId } = useParams();
  const { workspace } = useSignedIn();
  const base = `/workspaces/${workspace?.workspaceId}`;
  const dataset = useApiData<DatasetDetail>(`${base}/datasets/${datasetId}`);
  const uploads = useApiData<UploadDetail[]>(`${base}/uploads?datasetId=${datasetId}`);
  const [uploading, setUploading] = useState(false);

  const reloadDataset = dataset.retry;
  const reloadUploads = uploads.retry;
  const reload = useCallback(() => {
    reloadDataset();
    reloadUploads();
  }, [reloadDataset, reloadUploads]);

  if (dataset.status === 'loading') {
    return (
      <PageFrame title="Dataset">
        <LoadingState label="Loading dataset" />
      </PageFrame>
    );
  }
  if (dataset.status === 'error') {
    const missing = dataset.error.status === 404;
    return (
      <PageFrame title="Dataset">
        <ErrorState
          title={missing ? 'Dataset not found' : 'Could not load this dataset'}
          description={
            missing
              ? 'It may have been removed, or it belongs to another workspace.'
              : (dataset.error.detail ?? dataset.error.message)
          }
          onRetry={missing ? undefined : dataset.retry}
          retrying={dataset.retrying}
        />
      </PageFrame>
    );
  }

  const d = dataset.data;
  const profile = d.latestProfile;
  // Facts come from the last good profile; a newer failure is shown above them.
  const succeeded = d.lastSuccessfulProfile;
  const isCsv = d.locator.format === 'csv';

  return (
    <PageFrame title={d.name} summary={d.description ?? `A dataset in ${d.sourceName}.`}>
      {workspace !== undefined && canEdit(workspace.role) && isCsv && (
        <div className="page-actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => setUploading(true)}
          >
            Upload CSV
          </button>
        </div>
      )}

      <section aria-label="Summary">
        <dl className="dataset-summary">
          <div>
            <dt>Rows</dt>
            <dd>{succeeded?.rowCount == null ? 'Not profiled' : count(succeeded.rowCount)}</dd>
          </div>
          <div>
            <dt>Columns</dt>
            <dd>{succeeded === null ? 'Not profiled' : count(succeeded.columns.length)}</dd>
          </div>
          <div>
            <dt>Data last updated</dt>
            <dd>{at(succeeded?.lastUpdatedAt ?? null)}</dd>
          </div>
          <div>
            <dt>Last profiled</dt>
            <dd>{at(profile?.observedAt ?? null)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{d.sourceName}</dd>
          </div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="profile-title">
        <h2 id="profile-title" className="panel__title">
          Profile
        </h2>
        {profile?.status === 'failed' && (
          <div role="alert" className="dataset-profile__failed">
            <StatusMark tone="critical" label="The latest profile failed" />
            <p>{profile.error?.message}</p>
            {profile.error?.hint && <p className="dataset-uploads__hint">{profile.error.hint}</p>}
            {succeeded !== null && (
              <p>Below is the last successful profile, from {at(succeeded.observedAt)}.</p>
            )}
          </div>
        )}
        {(profile?.status !== 'failed' || succeeded !== null) && (
          <DataTable
            caption={
              profile?.status === 'failed'
                ? 'Columns in the last successful profile'
                : 'Columns in the latest profile'
            }
            columns={profileColumns(succeeded?.rowCount ?? 0)}
            rows={succeeded?.columns ?? []}
            rowKey={(c) => String(c.ordinal)}
            empty={
              <EmptyState
                title="Not profiled yet"
                description={
                  isCsv
                    ? 'Upload a CSV file to see its columns, types, and empty values.'
                    : 'A profile appears after the first check of this dataset.'
                }
              />
            }
          />
        )}
      </section>

      <section className="panel" aria-labelledby="uploads-title">
        <h2 id="uploads-title" className="panel__title">
          Uploads
        </h2>
        {uploads.status === 'error' ? (
          <ErrorState
            title="Could not load uploads"
            description={uploads.error.detail ?? uploads.error.message}
            onRetry={uploads.retry}
            retrying={uploads.retrying}
          />
        ) : (
          <DataTable
            caption="Recent uploads"
            columns={uploadColumns}
            rows={uploads.status === 'ready' ? uploads.data : []}
            rowKey={(u) => u.id}
            status={uploads.status === 'loading' ? 'loading' : 'ready'}
            empty={
              <EmptyState
                title="No uploads yet"
                description="Files uploaded to this dataset are listed here with their result."
              />
            }
          />
        )}
      </section>

      {uploading && workspace !== undefined && (
        <UploadCsvDialog
          workspaceId={workspace.workspaceId}
          sourceId={d.sourceId}
          datasetId={d.id}
          onClose={() => setUploading(false)}
          onUploaded={reload}
        />
      )}
    </PageFrame>
  );
}
