import type { DatasetSummary } from '@datasentinel/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { UploadCsvDialog } from '../uploads/UploadCsvDialog.tsx';
import { canEdit, lifecycleLabel, sensitivityLabel } from './labels.ts';

const columns: Column<DatasetSummary>[] = [
  {
    key: 'name',
    header: 'Dataset',
    cell: (d) => <Link to={`/datasets/${d.id}`}>{d.name}</Link>,
    sortValue: (d) => d.name,
  },
  { key: 'source', header: 'Source', cell: (d) => d.sourceName, sortValue: (d) => d.sourceName },
  { key: 'key', header: 'Location', cell: (d) => <span className="mono">{d.stableKey}</span> },
  { key: 'status', header: 'Status', cell: (d) => lifecycleLabel[d.status] },
  { key: 'sensitivity', header: 'Sensitivity', cell: (d) => sensitivityLabel[d.sensitivity] },
];

/** The workspace's datasets, from the API (D-39). */
export function DatasetsPage() {
  const { workspace } = useSignedIn();
  const datasets = useApiData<DatasetSummary[]>(`/workspaces/${workspace?.workspaceId}/datasets`);
  const [uploading, setUploading] = useState(false);
  const mayUpload = workspace !== undefined && canEdit(workspace.role);

  return (
    <PageFrame
      title="Datasets"
      summary="Profiles, rules, schema history, and check results for each dataset."
    >
      {mayUpload && (
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
      {datasets.status === 'error' ? (
        <ErrorState
          title="Could not load datasets"
          description={datasets.error.detail ?? datasets.error.message}
          onRetry={datasets.retry}
          retrying={datasets.retrying}
        />
      ) : (
        <DataTable
          caption="Datasets"
          columns={columns}
          rows={datasets.status === 'ready' ? datasets.data : []}
          rowKey={(d) => d.id}
          status={datasets.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No datasets yet"
              description={
                mayUpload
                  ? 'Upload a CSV file to create your first dataset.'
                  : 'Datasets appear after a data source is connected and checked.'
              }
            />
          }
        />
      )}
      {uploading && workspace !== undefined && (
        <UploadCsvDialog
          workspaceId={workspace.workspaceId}
          onClose={() => setUploading(false)}
          onUploaded={datasets.retry}
        />
      )}
    </PageFrame>
  );
}
