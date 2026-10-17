import {
  pipelineRunStatuses,
  type PipelineRunListItem,
  type PipelineRunPage,
  type SourceSummary,
} from '@datasentinel/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { formatTime } from '../format.ts';
import { pipelineRunDisplay } from './runDisplay.ts';
import './PipelineRunsPage.css';

const PAGE_SIZE = 25;

interface Filters {
  status: string;
  sourceId: string;
  from: string;
  to: string;
}

const noFilters: Filters = { status: '', sourceId: '', from: '', to: '' };

function runsPath(workspaceId: string, f: Filters, cursor?: string) {
  const q = new URLSearchParams();
  if (f.status !== '') q.set('status', f.status);
  if (f.sourceId !== '') q.set('sourceId', f.sourceId);
  if (f.from !== '') q.set('from', `${f.from}T00:00:00.000Z`);
  if (f.to !== '') q.set('to', `${f.to}T23:59:59.999Z`);
  q.set('limit', String(PAGE_SIZE));
  if (cursor !== undefined) q.set('cursor', cursor);
  return `/workspaces/${workspaceId}/pipeline-runs?${q.toString()}`;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError; retrying: boolean }
  | { status: 'ready'; runs: PipelineRunListItem[]; nextCursor: string | null };

const toError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'unreachable', 'Failed.');

/** Pipeline runs, newest first, with filters and "Show older runs". */
export function PipelineRunsPage() {
  const { workspace } = useSignedIn();
  const workspaceId = workspace?.workspaceId;
  const sources = useApiData<SourceSummary[]>(`/workspaces/${workspaceId}/sources`);
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (workspaceId === undefined) return;
    const request = ++latest.current;
    let cancelled = false;
    apiFetch<PipelineRunPage>(runsPath(workspaceId, filters)).then(
      (page) => {
        if (cancelled || request !== latest.current) return;
        setLoadingMore(false);
        setMoreFailed(false);
        setLoad({ status: 'ready', runs: page.runs, nextCursor: page.nextCursor });
      },
      (e: unknown) => {
        if (cancelled || request !== latest.current) return;
        setLoad({ status: 'error', error: toError(e), retrying: false });
      },
    );
    return () => {
      // A filter change or unmount ends this request; a newer request also
      // outdates it through the counter.
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

  function showOlder(cursor: string) {
    if (workspaceId === undefined) return;
    const request = ++latest.current;
    setLoadingMore(true);
    setMoreFailed(false);
    apiFetch<PipelineRunPage>(runsPath(workspaceId, filters, cursor)).then(
      (page) => {
        if (request !== latest.current) return;
        setLoadingMore(false);
        setLoad((s) =>
          s.status === 'ready'
            ? { status: 'ready', runs: [...s.runs, ...page.runs], nextCursor: page.nextCursor }
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

  const pipelineSources =
    sources.status === 'ready' ? sources.data.filter((s) => s.type === 'pipeline_event') : [];
  const filtered = Object.values(filters).some((v) => v !== '');

  return (
    <PageFrame
      title="Pipeline runs"
      summary="A timeline of pipeline runs and the checks that ran near them."
    >
      <form className="runs-filters" role="search" aria-label="Run filters">
        <label>
          Status
          <select
            className="text-input"
            value={filters.status}
            onChange={(e) => change({ status: e.target.value })}
          >
            <option value="">All statuses</option>
            {pipelineRunStatuses.map((s) => (
              <option key={s} value={s}>
                {pipelineRunDisplay[s].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select
            className="text-input"
            value={filters.sourceId}
            onChange={(e) => change({ sourceId: e.target.value })}
          >
            <option value="">All sources</option>
            {pipelineSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            className="text-input"
            value={filters.from}
            onChange={(e) => change({ from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            className="text-input"
            value={filters.to}
            onChange={(e) => change({ to: e.target.value })}
          />
        </label>
      </form>
      {load.status === 'loading' && <LoadingState label="Loading pipeline runs" />}
      {load.status === 'error' && (
        <ErrorState
          title="Could not load pipeline runs"
          description={load.error.detail ?? load.error.message}
          onRetry={retry}
          retrying={load.retrying}
        />
      )}
      {load.status === 'ready' &&
        (load.runs.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No runs match these filters"
              description="Change or clear the filters."
            />
          ) : (
            <EmptyState
              title="No pipeline runs yet"
              description="Runs appear when an external job reports to a pipeline-event source."
            />
          )
        ) : (
          <>
            <Timeline
              label="Pipeline run timeline"
              events={load.runs.map((r) => ({
                id: r.id,
                time: formatTime(r.lastEventAt),
                actor: r.sourceName,
                text: `${r.name} ${pipelineRunDisplay[r.status].label.toLowerCase()}${
                  r.datasetName === null ? '' : ` (${r.datasetName})`
                }`,
              }))}
            />
            {moreFailed && <p role="alert">Could not load older runs. Try again.</p>}
            {load.nextCursor !== null && (
              <button
                type="button"
                className="button"
                disabled={loadingMore}
                onClick={() => showOlder(load.nextCursor as string)}
              >
                Show older runs
              </button>
            )}
          </>
        ))}
    </PageFrame>
  );
}
