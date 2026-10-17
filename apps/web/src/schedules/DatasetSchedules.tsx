import type { RuleDetail, ScheduleDetail } from '@datasentinel/contracts';
import { useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatTime } from '../format.ts';
import { describeSchedule } from './describeSchedule.ts';
import './DatasetSchedules.css';
import { ScheduleDialog } from './ScheduleDialog.tsx';

function lastOccurrence(s: ScheduleDetail): string {
  const o = s.recentOccurrences[0];
  if (o === undefined) return 'Not run yet';
  if (o.status === 'enqueued') return `Queued ${formatTime(o.scheduledFor)}`;
  if (o.status === 'pending') return 'Starting';
  if (o.skipReason === 'dataset_not_active') return 'Skipped: dataset not active';
  if (o.skipReason === 'previous_still_running') return 'Skipped: previous run still going';
  return 'Skipped';
}

/** The dataset's schedules (FR-06): what runs and when, with the next run
 * and the latest occurrence. Editors add, pause, change, and delete. */
export function DatasetSchedules({
  workspaceId,
  datasetId,
  editable,
}: {
  workspaceId: string;
  datasetId: string;
  editable: boolean;
}) {
  const base = `/workspaces/${workspaceId}`;
  const schedules = useApiData<ScheduleDetail[]>(`${base}/datasets/${datasetId}/schedules`);
  const rules = useApiData<RuleDetail[]>(`${base}/datasets/${datasetId}/rules`);
  const ruleList = rules.status === 'ready' ? rules.data : [];
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<ScheduleDetail | null>(null);
  const [deleting, setDeleting] = useState<ScheduleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = schedules.retry;

  async function toggle(s: ScheduleDetail) {
    setError(null);
    try {
      await apiFetch<ScheduleDetail>(`${base}/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? (e.detail ?? e.message) : 'The schedule could not change.');
    }
  }

  async function remove(s: ScheduleDetail) {
    setError(null);
    try {
      await apiFetch<void>(`${base}/schedules/${s.id}`, { method: 'DELETE' });
      setDeleting(null);
      reload();
    } catch (e) {
      setDeleting(null);
      setError(
        e instanceof ApiError ? (e.detail ?? e.message) : 'The schedule could not be deleted.',
      );
    }
  }

  const columns: Column<ScheduleDetail>[] = [
    {
      key: 'runs',
      header: 'Runs',
      cell: (s) => (
        <div className="dataset-schedules__runs">
          <span>{describeSchedule(s.definition)}</span>
          <span className="dataset-schedules__what">
            {s.ruleId === null
              ? 'Whole dataset'
              : `Rule: ${ruleList.find((r) => r.id === s.ruleId)?.name ?? 'One rule'}`}
          </span>
        </div>
      ),
    },
    {
      key: 'next',
      header: 'Next run',
      cell: (s) =>
        s.enabled ? (
          s.nextRunAt === null ? (
            '—'
          ) : (
            formatTime(s.nextRunAt)
          )
        ) : (
          <StatusMark tone="neutral" label="Paused" />
        ),
    },
    { key: 'last', header: 'Last occurrence', cell: lastOccurrence },
    ...(editable
      ? [
          {
            key: 'actions',
            header: 'Actions',
            cell: (s: ScheduleDetail) => {
              const hidden = (
                <span className="visually-hidden"> {describeSchedule(s.definition)}</span>
              );
              return (
                <div className="dataset-schedules__actions">
                  <button type="button" className="button" onClick={() => void toggle(s)}>
                    {s.enabled ? 'Pause' : 'Resume'}
                    {hidden}
                  </button>
                  <button type="button" className="button" onClick={() => setChanging(s)}>
                    Change{hidden}
                  </button>
                  <button type="button" className="button" onClick={() => setDeleting(s)}>
                    Delete{hidden}
                  </button>
                </div>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <section className="panel" aria-labelledby="schedules-title">
      <div className="dataset-schedules__head">
        <h2 id="schedules-title" className="panel__title">
          Schedules
        </h2>
        {editable && (
          <button type="button" className="button" onClick={() => setAdding(true)}>
            Add schedule
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="dataset-schedules__error">
          {error}
        </p>
      )}
      {schedules.status === 'error' ? (
        <ErrorState
          title="Could not load schedules"
          description={schedules.error.detail ?? schedules.error.message}
          onRetry={schedules.retry}
          retrying={schedules.retrying}
        />
      ) : (
        <DataTable
          caption="Schedules on this dataset"
          columns={columns}
          rows={schedules.status === 'ready' ? schedules.data : []}
          rowKey={(s) => s.id}
          status={schedules.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No schedules yet"
              description="Without a schedule, checks run only when someone selects Run now."
            />
          }
        />
      )}
      {adding && (
        <ScheduleDialog
          workspaceId={workspaceId}
          datasetId={datasetId}
          rules={ruleList}
          onClose={() => setAdding(false)}
          onSaved={reload}
        />
      )}
      {changing !== null && (
        <ScheduleDialog
          workspaceId={workspaceId}
          datasetId={datasetId}
          rules={ruleList}
          existing={changing}
          onClose={() => setChanging(null)}
          onSaved={reload}
        />
      )}
      <ConfirmActionDialog
        open={deleting !== null}
        title="Delete schedule"
        target={deleting === null ? '' : describeSchedule(deleting.definition)}
        effect="Checks stop running on this schedule. Past results stay."
        permission="Data engineer or above"
        confirmLabel="Delete schedule"
        onConfirm={() => (deleting === null ? undefined : remove(deleting))}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
