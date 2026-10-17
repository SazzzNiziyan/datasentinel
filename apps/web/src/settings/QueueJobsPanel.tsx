import type { QueueJobList, QueueJobSummary } from '@datasentinel/contracts';
import { useApiData } from '../api/useApiData.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatTime } from '../format.ts';

const jobNames: Record<string, string> = {
  'run-check': 'Rule check',
  'profile-dataset': 'Dataset profile',
  'parse-upload': 'CSV file processing',
  'test-connection': 'Connection test',
  'discover-tables': 'Table discovery',
};

const columns: Column<QueueJobSummary>[] = [
  { key: 'job', header: 'Job', cell: (j) => jobNames[j.name] ?? j.name },
  {
    key: 'status',
    header: 'Status',
    cell: (j) =>
      j.state === 'failed' ? (
        <StatusMark tone="critical" label="Failed" />
      ) : (
        <StatusMark tone="warning" label="Stalled" />
      ),
  },
  { key: 'tries', header: 'Tries', cell: (j) => `${j.attemptsMade} of ${j.attempts}` },
  { key: 'added', header: 'Added', cell: (j) => formatTime(j.addedAt) },
  { key: 'failure', header: 'Failure', cell: (j) => j.failure ?? '—' },
];

/** Failed and stalled background jobs, for admins and owners. */
export function QueueJobsPanel({ workspaceId }: { workspaceId: string }) {
  const jobs = useApiData<QueueJobList>(`/workspaces/${workspaceId}/queue-jobs`);

  return (
    <section className="panel" aria-labelledby="queue-jobs-title">
      <h2 id="queue-jobs-title" className="panel__title">
        Background jobs
      </h2>
      <p>
        Jobs that ran out of retries, or have waited or run for over 15 minutes. Failed jobs are
        kept for 7 days.
      </p>
      {jobs.status === 'error' ? (
        <ErrorState
          title="Could not load background jobs"
          description={jobs.error.detail ?? jobs.error.message}
          onRetry={jobs.retry}
          retrying={jobs.retrying}
        />
      ) : (
        <>
          <DataTable
            caption="Failed and stalled background jobs"
            columns={columns}
            rows={jobs.status === 'ready' ? jobs.data.jobs : []}
            rowKey={(j) => `${j.queue}:${j.jobId}`}
            status={jobs.status === 'loading' ? 'loading' : 'ready'}
            empty={
              <EmptyState
                title="No failed or stalled jobs"
                description="Background work is running normally."
              />
            }
          />
          {jobs.status === 'ready' && jobs.data.omitted > 0 && (
            <p>{`${jobs.data.omitted} more jobs are not shown.`}</p>
          )}
        </>
      )}
    </section>
  );
}
