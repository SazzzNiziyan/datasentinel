import type { SourceSummary } from '@datasentinel/contracts';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { lifecycleLabel, sourceTypeLabel } from './labels.ts';

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
  const sources = useApiData<SourceSummary[]>(`/workspaces/${workspace?.workspaceId}/sources`);

  return (
    <PageFrame
      title="Data sources"
      summary="CSV uploads, PostgreSQL connections, and API checks, with their health."
    >
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
              description="Checks run against a data source. Connecting PostgreSQL and uploading CSV files arrive with the next steps of this release."
            />
          }
        />
      )}
    </PageFrame>
  );
}
