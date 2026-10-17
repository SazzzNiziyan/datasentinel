import type { CheckRunSummary, RuleDetail } from '@datasentinel/contracts';
import { Link, useParams } from 'react-router';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { formatDuration, formatTime } from '../format.ts';
import '../pages/DatasetDetailPage.css';
import { runDisplay } from './runDisplay.ts';
import { describeRule } from './describeRule.ts';
import { describeRun } from './describeRun.ts';
import { ruleTypeLabels } from './ruleForm.ts';

const triggers = { manual: 'Run now', schedule: 'Schedule', event: 'Source event' } as const;

/** One rule and its check history (D-68): each run with the revision it
 * checked, its result, and what was measured, in units with the method
 * and comparison window. */
export function RulePage() {
  const { ruleId } = useParams();
  const { workspace } = useSignedIn();
  const rule = useApiData<RuleDetail>(`/workspaces/${workspace?.workspaceId}/rules/${ruleId}`);

  if (rule.status === 'loading') {
    return (
      <PageFrame title="Rule">
        <LoadingState label="Loading rule" />
      </PageFrame>
    );
  }
  if (rule.status === 'error') {
    const missing = rule.error.status === 404;
    return (
      <PageFrame title="Rule">
        <ErrorState
          title={missing ? 'Rule not found' : 'Could not load this rule'}
          description={
            missing
              ? 'It may have been removed, or it belongs to another workspace.'
              : (rule.error.detail ?? rule.error.message)
          }
          onRetry={missing ? undefined : rule.retry}
          retrying={rule.retrying}
        />
      </PageFrame>
    );
  }
  const r = rule.data;
  const columns: Column<CheckRunSummary>[] = [
    {
      key: 'when',
      header: 'Checked',
      cell: (c) => formatTime(c.createdAt),
      sortValue: (c) => c.createdAt,
    },
    { key: 'version', header: 'Rule version', cell: (c) => `v${c.ruleVersion}`, numeric: true },
    { key: 'trigger', header: 'Started by', cell: (c) => triggers[c.trigger] },
    {
      key: 'result',
      header: 'Result',
      cell: (c) => (
        <StatusMark tone={runDisplay[c.status].tone} label={runDisplay[c.status].label} />
      ),
    },
    { key: 'measured', header: 'Measured', cell: (c) => describeRun(r.type, c) },
    {
      key: 'took',
      header: 'Took',
      cell: (c) => (c.durationMs === null ? '–' : formatDuration(c.durationMs)),
      numeric: true,
    },
  ];

  return (
    <PageFrame title={r.name} summary={describeRule(r.definition)}>
      <section aria-label="Summary">
        <dl className="dataset-summary">
          <div>
            <dt>Severity</dt>
            <dd>
              <SeverityBadge severity={r.severity} />
            </dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd>{ruleTypeLabels[r.type]}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>v{r.version}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{r.enabled ? 'On' : 'Turned off'}</dd>
          </div>
        </dl>
        <p>
          <Link to={`/datasets/${r.datasetId}`}>Back to the dataset</Link>
        </p>
      </section>
      <section className="panel" aria-labelledby="runs-title">
        <h2 id="runs-title" className="panel__title">
          Check history
        </h2>
        <DataTable
          caption="The 20 most recent checks"
          columns={columns}
          rows={r.recentRuns}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              title="Not checked yet"
              description="Each check of this rule is listed here with what it measured."
            />
          }
        />
      </section>
    </PageFrame>
  );
}
