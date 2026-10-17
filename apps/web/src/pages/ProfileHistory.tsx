import type { ProfileHistoryEntry } from '@datasentinel/contracts';
import { useApiData } from '../api/useApiData.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatCount, formatDuration, formatTime } from '../format.ts';

const rows = (p: ProfileHistoryEntry) =>
  p.rowCount === null
    ? '–'
    : p.rowCountMethod === 'approximate'
      ? `About ${formatCount(p.rowCount)} (database estimate)`
      : `${formatCount(p.rowCount)} (exact count)`;

const schema = (p: ProfileHistoryEntry) =>
  p.schemaChanged === null ? '–' : p.schemaChanged ? 'Changed' : 'Same';

const columns: Column<ProfileHistoryEntry>[] = [
  {
    key: 'when',
    header: 'Profiled',
    cell: (p) => formatTime(p.observedAt),
    sortValue: (p) => p.observedAt,
  },
  {
    key: 'result',
    header: 'Result',
    cell: (p) =>
      p.status === 'succeeded' ? (
        <StatusMark tone="healthy" label="Succeeded" />
      ) : (
        <span>
          <StatusMark tone="critical" label="Failed" /> {p.error?.message}
        </span>
      ),
  },
  { key: 'rows', header: 'Rows', cell: rows, numeric: true, sortValue: (p) => p.rowCount ?? -1 },
  {
    key: 'columns',
    header: 'Columns',
    cell: (p) => (p.columnCount === null ? '–' : formatCount(p.columnCount)),
    numeric: true,
  },
  { key: 'schema', header: 'Schema since the profile before', cell: schema },
  { key: 'took', header: 'Took', cell: (p) => formatDuration(p.durationMs), numeric: true },
];

/** A dataset's recent profiles (D-68): how each row count was measured,
 * the column count, and whether the schema changed. */
export function ProfileHistory({
  workspaceId,
  datasetId,
}: {
  workspaceId: string;
  datasetId: string;
}) {
  const history = useApiData<ProfileHistoryEntry[]>(
    `/workspaces/${workspaceId}/datasets/${datasetId}/profiles`,
  );
  return (
    <section className="panel" aria-labelledby="profile-history-title">
      <h2 id="profile-history-title" className="panel__title">
        Profile history
      </h2>
      {history.status === 'error' ? (
        <ErrorState
          title="Could not load profile history"
          description={history.error.detail ?? history.error.message}
          onRetry={history.retry}
          retrying={history.retrying}
        />
      ) : (
        <DataTable
          caption="The 30 most recent profiles"
          columns={columns}
          rows={history.status === 'ready' ? history.data : []}
          rowKey={(p) => p.id}
          status={history.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No profiles yet"
              description="Each profile of this dataset is listed here with its row count and schema."
            />
          }
        />
      )}
    </section>
  );
}
