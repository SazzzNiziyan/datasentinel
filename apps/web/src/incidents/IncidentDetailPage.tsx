import type {
  IncidentDetail,
  IncidentEvidenceItem,
  IncidentHistoryItem,
  IncidentRelatedRun,
  IncidentStatus,
  PipelineRunStatus,
  RuleType,
} from '@datasentinel/contracts';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingState } from '../components/LoadingState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { formatTime } from '../format.ts';
import '../pages/DatasetDetailPage.css';
import { canComment, canEdit } from '../pages/labels.ts';
import { describeRun } from '../rules/describeRun.ts';
import { ruleTypeLabels } from '../rules/ruleForm.ts';
import { pipelineRunDisplay } from '../runs/runDisplay.ts';
import { IncidentActions } from './IncidentActions.tsx';
import { IncidentComments } from './IncidentComments.tsx';
import { incidentStatusLabel, incidentStatusTone } from './incidentDisplay.ts';
import { InvestigationPanel } from './InvestigationPanel.tsx';
import { RecoveryActionsPanel } from './RecoveryActionsPanel.tsx';

const kindLabels: Record<string, string> = {
  check_run: 'Failed check',
  profile_snapshot: 'Profile',
  schema_snapshot: 'Schema',
  pipeline_run: 'Pipeline run',
};

const reasonText = {
  dataset_id: 'The run names this dataset',
  correlation_id: "The run references this dataset's ID",
} as const;

const isRuleType = (v: string): v is RuleType => Object.hasOwn(ruleTypeLabels, v);

const isRunStatus = (v: string): v is PipelineRunStatus => Object.hasOwn(pipelineRunDisplay, v);

const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

const show = (v: unknown): string => {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'object') return JSON.stringify(v);
  return typeof v === 'string' ? v : `${v as number | boolean}`;
};

function timing(minutes: number): string {
  if (minutes === 0) return 'Active during the check';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before the check`;
}

function summarize(summary: Record<string, unknown>): string {
  const text = Object.entries(summary)
    .filter(([, v]) => v === null || typeof v !== 'object')
    .map(([k, v]) => `${k}: ${show(v)}`)
    .join(', ');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function statusWord(s: IncidentStatus | null): string | null {
  return s === null ? null : incidentStatusLabel[s];
}

const withText = (base: string, sep: string, v: unknown) =>
  typeof v === 'string' ? `${base}${sep}${v}` : base;

function historyText(h: IncidentHistoryItem): string {
  let text: string;
  if (h.type === 'opened') text = 'Incident opened';
  else if (h.type === 'acknowledged') return 'Acknowledged';
  else if (h.type === 'investigating') return 'Investigation started';
  else if (h.type === 'resolved') return withText('Resolved', ': ', h.details.resolutionNote);
  else if (h.type === 'assigned') {
    const name = typeof h.details.toName === 'string' ? h.details.toName : 'someone';
    return `Assigned to ${name}`;
  } else if (h.type === 'unassigned') return 'Unassigned';
  else if (h.type === 'reopened') {
    if (h.details.automatic === false) return withText('Reopened', ': ', h.details.reason);
    text = `Incident reopened${h.details.automatic === true ? ' automatically after a repeat failure' : ''}`;
  } else {
    const spaced = h.type.replace(/_/g, ' ');
    text = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  const from = statusWord(h.fromStatus);
  const to = statusWord(h.toStatus);
  return from !== null && to !== null ? `${text} (${from} to ${to})` : text;
}

function Values({ title, values }: { title: string; values: Record<string, unknown> | null }) {
  return (
    <div>
      <h3>{title}</h3>
      {values === null || Object.keys(values).length === 0 ? (
        <p>Nothing recorded.</p>
      ) : (
        <dl className="dataset-summary">
          {Object.entries(values).map(([k, v]) => (
            <div key={k}>
              <dt>{words(k)}</dt>
              <dd>{show(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

const runColumns: Column<IncidentRelatedRun>[] = [
  { key: 'name', header: 'Run', cell: (r) => r.name },
  { key: 'source', header: 'Source', cell: (r) => r.sourceName },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => (isRunStatus(r.status) ? pipelineRunDisplay[r.status].label : r.status),
  },
  { key: 'why', header: 'Why linked', cell: (r) => reasonText[r.reason] },
  { key: 'timing', header: 'Timing', cell: (r) => timing(r.distanceMinutes) },
];

const evidenceColumns = (all: IncidentEvidenceItem[]): Column<IncidentEvidenceItem>[] => [
  {
    key: 'ref',
    header: 'Ref',
    cell: (e) => <span id={`evidence-${e.id}`}>{all.indexOf(e) + 1}</span>,
  },
  { key: 'kind', header: 'Kind', cell: (e) => kindLabels[e.kind] ?? e.kind },
  { key: 'observed', header: 'Observed', cell: (e) => formatTime(e.observedAt) },
  { key: 'summary', header: 'Summary', cell: (e) => summarize(e.summary) },
];

/** One incident: summary, the failed check, related runs, evidence, history. */
export function IncidentDetailPage() {
  const { incidentId } = useParams();
  const { workspace } = useSignedIn();
  const incident = useApiData<IncidentDetail>(
    `/workspaces/${workspace?.workspaceId}/incidents/${incidentId}`,
  );
  // The newest copy returned by an action; a reload clears it.
  const [updated, setUpdated] = useState<IncidentDetail | null>(null);

  if (incident.status === 'loading') {
    return (
      <PageFrame title="Incident">
        <LoadingState label="Loading incident" />
      </PageFrame>
    );
  }
  if (incident.status === 'error') {
    return (
      <PageFrame title="Incident">
        <ErrorState
          title={
            incident.error.status === 404 ? 'Incident not found' : 'Could not load this incident'
          }
          description={incident.error.detail ?? incident.error.message}
          onRetry={incident.retry}
          retrying={incident.retrying}
        />
      </PageFrame>
    );
  }
  const i = updated !== null && updated.id === incident.data.id ? updated : incident.data;
  const check = i.latestCheck;
  const measured =
    check !== null && isRuleType(i.ruleType)
      ? describeRun(i.ruleType, {
          id: check.checkRunId,
          ruleVersion: check.ruleVersion ?? 0,
          trigger: 'manual',
          status: 'failed',
          expected: check.expected,
          actual: check.actual,
          error: null,
          createdAt: check.observedAt,
          startedAt: null,
          endedAt: null,
          durationMs: null,
        })
      : null;

  return (
    <PageFrame title={i.title}>
      <section aria-label="Summary">
        <dl className="dataset-summary">
          <div>
            <dt>Severity</dt>
            <dd>
              <SeverityBadge severity={i.severity} />
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <StatusMark
                tone={incidentStatusTone(i.status)}
                label={incidentStatusLabel[i.status]}
              />
            </dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>
              <Link to={`/datasets/${i.datasetId}`}>{i.datasetName}</Link>
            </dd>
          </div>
          <div>
            <dt>Rule</dt>
            <dd>
              <Link to={`/rules/${i.ruleId}`}>{i.ruleName}</Link>
            </dd>
          </div>
          <div>
            <dt>Assigned to</dt>
            <dd>{i.assigneeName ?? 'Unassigned'}</dd>
          </div>
          <div>
            <dt>Failed checks</dt>
            <dd>{i.failureCount}</dd>
          </div>
          <div>
            <dt>Opened</dt>
            <dd>{formatTime(i.openedAt)}</dd>
          </div>
          <div>
            <dt>Last failure</dt>
            <dd>{formatTime(i.lastFailureAt)}</dd>
          </div>
        </dl>
        {i.resolutionNote !== null && (
          <>
            <h3>Resolution note</h3>
            <p>{i.resolutionNote}</p>
          </>
        )}
      </section>
      {workspace !== undefined && canEdit(workspace.role) && (
        <IncidentActions
          workspaceId={workspace.workspaceId}
          incident={i}
          onUpdated={setUpdated}
          onReload={() => {
            setUpdated(null);
            incident.retry();
          }}
        />
      )}
      <section className="panel" aria-labelledby="check-title">
        <h2 id="check-title" className="panel__title">
          Latest failed check
        </h2>
        {check === null ? (
          <p>No check result is attached yet.</p>
        ) : (
          <>
            <p>
              {formatTime(check.observedAt)}
              {check.ruleVersion !== null && ` · Rule version ${check.ruleVersion}`}
            </p>
            {measured !== null && <p>{measured}</p>}
            <Values title="Expected" values={check.expected} />
            <Values title="Actual" values={check.actual} />
          </>
        )}
      </section>
      <section className="panel" aria-labelledby="runs-title">
        <h2 id="runs-title" className="panel__title">
          Related pipeline runs
        </h2>
        {i.relatedRuns.length === 0 ? (
          <p>No pipeline run is linked to this incident.</p>
        ) : (
          <DataTable
            caption="Pipeline runs linked to this incident"
            columns={runColumns}
            rows={i.relatedRuns}
            rowKey={(r) => `${r.pipelineRunId}-${r.reason}`}
            empty={<p>No pipeline run is linked to this incident.</p>}
          />
        )}
      </section>
      <section className="panel" aria-labelledby="evidence-title">
        <h2 id="evidence-title" className="panel__title">
          Evidence
        </h2>
        <DataTable
          caption="Evidence for this incident"
          columns={evidenceColumns(i.evidence)}
          rows={i.evidence}
          rowKey={(e) => e.id}
          empty={<p>No evidence is attached yet.</p>}
        />
      </section>
      <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title" className="panel__title">
          History
        </h2>
        <Timeline
          label="Incident history"
          events={i.history.map((h) => ({
            id: h.id,
            time: formatTime(h.createdAt),
            actor: h.actorName ?? (h.actorType === 'system' ? 'DataSentinel' : 'Someone'),
            text: historyText(h),
          }))}
        />
      </section>
      {workspace !== undefined && (
        <InvestigationPanel
          workspaceId={workspace.workspaceId}
          incidentId={i.id}
          role={workspace.role}
          evidence={i.evidence}
        />
      )}
      {workspace !== undefined && (
        <RecoveryActionsPanel
          workspaceId={workspace.workspaceId}
          incidentId={i.id}
          role={workspace.role}
        />
      )}
      {workspace !== undefined && (
        <IncidentComments
          workspaceId={workspace.workspaceId}
          incident={i}
          canPost={canComment(workspace.role)}
          onUpdated={setUpdated}
        />
      )}
    </PageFrame>
  );
}
