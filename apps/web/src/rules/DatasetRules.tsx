import type { CheckRunSummary, RuleDetail } from '@datasentinel/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiFetch } from '../api/client.ts';
import { useApiData } from '../api/useApiData.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { describeRule } from './describeRule.ts';
import { runDisplay } from './runDisplay.ts';
import './DatasetRules.css';
import { RuleBuilderDialog } from './RuleBuilderDialog.tsx';

const POLL_MS = 1000;
const POLL_LIMIT = 30;

const finished = (run: CheckRunSummary | undefined) =>
  run !== undefined && run.status !== 'queued' && run.status !== 'running';

/** The dataset's rules with their latest result (FR-05, D-67). Editors add
 * rules and run one now; the run is followed until it finishes. */
export function DatasetRules({
  workspaceId,
  datasetId,
  datasetName,
  csv,
  active,
  editable,
  columns,
}: {
  workspaceId: string;
  datasetId: string;
  datasetName: string;
  csv: boolean;
  /** Checks run only on active datasets. */
  active: boolean;
  editable: boolean;
  columns: readonly { name: string; type: string }[];
}) {
  const base = `/workspaces/${workspaceId}`;
  const rules = useApiData<RuleDetail[]>(`${base}/datasets/${datasetId}/rules`);
  const [building, setBuilding] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // Set on every mount: development mode mounts twice, and a flag left
  // false by the first unmount would stop the follow-up below for good.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = rules.retry;

  async function runNow(rule: RuleDetail) {
    if (running !== null) return;
    setRunning(rule.id);
    setError(null);
    try {
      const run = await apiFetch<CheckRunSummary>(`${base}/rules/${rule.id}/runs`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
      });
      reload();
      for (let i = 0; i < POLL_LIMIT && !finished(run); i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!alive.current) return;
        const latest = await apiFetch<RuleDetail>(`${base}/rules/${rule.id}`);
        if (finished(latest.recentRuns.find((r) => r.id === run.id))) break;
      }
      reload();
    } catch (e) {
      if (alive.current) {
        setError(e instanceof ApiError ? e.message : 'The check could not start.');
      }
    } finally {
      if (alive.current) setRunning(null);
    }
  }

  const columnsOf: Column<RuleDetail>[] = [
    {
      key: 'rule',
      header: 'Rule',
      cell: (r) => (
        <div className="dataset-rules__rule">
          <Link className="dataset-rules__name" to={`/rules/${r.id}`}>
            {r.name}
          </Link>
          <span className="dataset-rules__condition">{describeRule(r.definition)}</span>
        </div>
      ),
      sortValue: (r) => r.name,
    },
    {
      key: 'severity',
      header: 'Severity',
      cell: (r) => <SeverityBadge severity={r.severity} />,
    },
    {
      key: 'result',
      header: 'Latest result',
      cell: (r) => {
        if (!r.enabled) return <StatusMark tone="neutral" label="Turned off" />;
        const last = r.recentRuns[0];
        if (last === undefined) return <StatusMark tone="neutral" label="Not run yet" />;
        const { tone, label } = runDisplay[last.status];
        return <StatusMark tone={tone} label={label} />;
      },
    },
    ...(editable && active
      ? [
          {
            key: 'actions',
            header: 'Actions',
            cell: (r: RuleDetail) =>
              r.enabled && (
                <button
                  type="button"
                  className="button"
                  aria-disabled={running !== null}
                  onClick={() => void runNow(r)}
                >
                  {running === r.id ? (
                    'Running…'
                  ) : (
                    <>
                      Run now<span className="visually-hidden"> {r.name}</span>
                    </>
                  )}
                </button>
              ),
          },
        ]
      : []),
  ];

  return (
    <section className="panel" aria-labelledby="rules-title">
      <div className="dataset-rules__head">
        <h2 id="rules-title" className="panel__title">
          Rules
        </h2>
        {editable && (
          <button type="button" className="button" onClick={() => setBuilding(true)}>
            Add rule
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="dataset-rules__error">
          {error}
        </p>
      )}
      {rules.status === 'error' ? (
        <ErrorState
          title="Could not load rules"
          description={rules.error.detail ?? rules.error.message}
          onRetry={rules.retry}
          retrying={rules.retrying}
        />
      ) : (
        <DataTable
          caption="Rules checked on this dataset"
          columns={columnsOf}
          rows={rules.status === 'ready' ? rules.data : []}
          rowKey={(r) => r.id}
          status={rules.status === 'loading' ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No rules yet"
              description="Rules say what healthy data looks like here, such as how fresh it must be or which columns must never be empty."
            />
          }
        />
      )}
      {building && (
        <RuleBuilderDialog
          workspaceId={workspaceId}
          datasetId={datasetId}
          datasetName={datasetName}
          csv={csv}
          columns={columns}
          onClose={() => setBuilding(false)}
          onCreated={reload}
        />
      )}
    </section>
  );
}
