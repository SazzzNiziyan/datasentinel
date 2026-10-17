import {
  incidentStatuses,
  type IncidentListItem,
  type IncidentPage,
} from '@datasentinel/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiFetch } from '../api/client.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatTime } from '../format.ts';
import { incidentStatusLabel, incidentStatusTone } from '../incidents/incidentDisplay.ts';
import '../runs/PipelineRunsPage.css';

const PAGE_SIZE = 25;

interface Filters {
  status: string;
  severity: string;
  assignee: string;
  sort: string;
}

const defaultFilters: Filters = { status: 'active', severity: '', assignee: '', sort: 'priority' };

function incidentsPath(workspaceId: string, f: Filters, offset?: number) {
  const q = new URLSearchParams();
  if (f.status !== '') q.set('status', f.status);
  if (f.severity !== '') q.set('severity', f.severity);
  if (f.assignee !== '') q.set('assignee', f.assignee);
  q.set('sort', f.sort);
  q.set('limit', String(PAGE_SIZE));
  if (offset !== undefined) q.set('offset', String(offset));
  return `/workspaces/${workspaceId}/incidents?${q.toString()}`;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError; retrying: boolean }
  | { status: 'ready'; incidents: IncidentListItem[]; total: number; nextOffset: number | null };

const toError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'unreachable', 'Failed.');

const columns: Column<IncidentListItem>[] = [
  {
    key: 'title',
    header: 'Incident',
    cell: (i) => <Link to={`/incidents/${i.id}`}>{i.title}</Link>,
  },
  { key: 'severity', header: 'Severity', cell: (i) => <SeverityBadge severity={i.severity} /> },
  {
    key: 'status',
    header: 'Status',
    cell: (i) => (
      <StatusMark tone={incidentStatusTone(i.status)} label={incidentStatusLabel[i.status]} />
    ),
  },
  {
    key: 'dataset',
    header: 'Dataset',
    cell: (i) => <Link to={`/datasets/${i.datasetId}`}>{i.datasetName}</Link>,
  },
  { key: 'assignee', header: 'Assigned to', cell: (i) => i.assigneeName ?? 'Unassigned' },
  { key: 'failures', header: 'Failures', cell: (i) => i.failureCount, numeric: true },
  { key: 'last', header: 'Last failure', cell: (i) => formatTime(i.lastFailureAt) },
];

/** Live incident list with filters and "Show more incidents". */
export function IncidentsPage() {
  const { workspace } = useSignedIn();
  const workspaceId = workspace?.workspaceId;
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (workspaceId === undefined) return;
    const request = ++latest.current;
    let cancelled = false;
    apiFetch<IncidentPage>(incidentsPath(workspaceId, filters)).then(
      (page) => {
        if (cancelled || request !== latest.current) return;
        setLoadingMore(false);
        setMoreFailed(false);
        setLoad({
          status: 'ready',
          incidents: page.incidents,
          total: page.total,
          nextOffset: page.nextOffset,
        });
      },
      (e: unknown) => {
        if (cancelled || request !== latest.current) return;
        setLoad({ status: 'error', error: toError(e), retrying: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, filters, attempt]);

  function change(patch: Partial<Filters>) {
    setLoad({ status: 'loading' });
    setFilters((f) => ({ ...f, ...patch }));
  }

  function retry() {
    setLoad((s) => (s.status === 'error' ? { ...s, retrying: true } : s));
    setAttempt((n) => n + 1);
  }

  function showMore(offset: number) {
    if (workspaceId === undefined) return;
    const request = ++latest.current;
    setLoadingMore(true);
    setMoreFailed(false);
    apiFetch<IncidentPage>(incidentsPath(workspaceId, filters, offset)).then(
      (page) => {
        if (request !== latest.current) return;
        setLoadingMore(false);
        setLoad((s) =>
          s.status === 'ready'
            ? {
                status: 'ready',
                incidents: [...s.incidents, ...page.incidents],
                total: page.total,
                nextOffset: page.nextOffset,
              }
            : s,
        );
      },
      () => {
        if (request !== latest.current) return;
        setLoadingMore(false);
        setMoreFailed(true);
      },
    );
  }

  const isDefault = (Object.keys(defaultFilters) as (keyof Filters)[]).every(
    (k) => filters[k] === defaultFilters[k],
  );

  return (
    <PageFrame
      title="Incidents"
      summary="Failed checks grouped into incidents. Most severe and oldest first."
    >
      <form className="runs-filters" role="search" aria-label="Incident filters">
        <label>
          Status
          <select
            className="text-input"
            value={filters.status}
            onChange={(e) => change({ status: e.target.value })}
          >
            <option value="active">Needs attention</option>
            <option value="">All statuses</option>
            {incidentStatuses.map((s) => (
              <option key={s} value={s}>
                {incidentStatusLabel[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity
          <select
            className="text-input"
            value={filters.severity}
            onChange={(e) => change({ severity: e.target.value })}
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>
          Assigned to
          <select
            className="text-input"
            value={filters.assignee}
            onChange={(e) => change({ assignee: e.target.value })}
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
        <label>
          Sort by
          <select
            className="text-input"
            value={filters.sort}
            onChange={(e) => change({ sort: e.target.value })}
          >
            <option value="priority">Priority</option>
            <option value="recent">Most recent failure</option>
          </select>
        </label>
      </form>
      {load.status === 'loading' && <LoadingState label="Loading incidents" />}
      {load.status === 'error' && (
        <ErrorState
          title="Could not load incidents"
          description={load.error.detail ?? load.error.message}
          onRetry={retry}
          retrying={load.retrying}
        />
      )}
      {load.status === 'ready' && (
        <>
          <p>{load.total === 1 ? '1 incident' : `${load.total} incidents`}</p>
          <DataTable
            caption="Incidents"
            columns={columns}
            rows={load.incidents}
            rowKey={(i) => i.id}
            empty={
              isDefault ? (
                <EmptyState
                  title="No open incidents"
                  description="Failed checks on critical rules open incidents automatically."
                />
              ) : (
                <EmptyState
                  title="No incidents match these filters"
                  description="Change or clear the filters."
                />
              )
            }
          />
          {moreFailed && <p role="alert">Could not load more incidents. Try again.</p>}
          {load.nextOffset !== null && (
            <button
              type="button"
              className="button"
              disabled={loadingMore}
              onClick={() => showMore(load.nextOffset as number)}
            >
              Show more incidents
            </button>
          )}
        </>
      )}
    </PageFrame>
  );
}
