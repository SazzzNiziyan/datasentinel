import type { DatasetSummary, IncidentListItem, IncidentPage } from '@datasentinel/contracts';
import { Link } from 'react-router';
import { useApiData } from '../api/useApiData.ts';
import { useSignedIn } from '../app/session.ts';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { MetricBlock } from '../components/MetricBlock.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { incidentStatusLabel } from '../incidents/incidentDisplay.ts';
import { lifecycleLabel } from './labels.ts';
import './OverviewPage.css';

const opened = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

const incidentColumns: Column<IncidentListItem>[] = [
  { key: 'severity', header: 'Severity', cell: (i) => <SeverityBadge severity={i.severity} /> },
  {
    key: 'title',
    header: 'Incident',
    cell: (i) => <Link to={`/incidents/${i.id}`}>{i.title}</Link>,
  },
  { key: 'dataset', header: 'Dataset', cell: (i) => i.datasetName },
  { key: 'opened', header: 'Opened', cell: (i) => `${opened.format(new Date(i.openedAt))} UTC` },
  { key: 'owner', header: 'Owner', cell: (i) => i.assigneeName ?? 'Unassigned' },
  { key: 'status', header: 'Status', cell: (i) => incidentStatusLabel[i.status] },
];

const datasetColumns: Column<DatasetSummary>[] = [
  {
    key: 'name',
    header: 'Dataset',
    cell: (d) => <Link to={`/datasets/${d.id}`}>{d.name}</Link>,
    sortValue: (d) => d.name,
  },
  { key: 'source', header: 'Source', cell: (d) => d.sourceName, sortValue: (d) => d.sourceName },
  { key: 'status', header: 'Status', cell: (d) => lifecycleLabel[d.status] },
];

/** The workspace at a glance, from live data: active incidents (most severe
 * and oldest first) and the datasets being monitored. */
export function OverviewPage() {
  const { workspace } = useSignedIn();
  const base = `/workspaces/${workspace?.workspaceId}`;
  const active = useApiData<IncidentPage>(`${base}/incidents?status=active&sort=priority&limit=10`);
  const critical = useApiData<IncidentPage>(
    `${base}/incidents?status=active&severity=critical&limit=1`,
  );
  const datasets = useApiData<DatasetSummary[]>(`${base}/datasets`);

  const activeTotal = active.status === 'ready' ? active.data.total : 0;
  const criticalTotal = critical.status === 'ready' ? critical.data.total : 0;
  const monitored =
    datasets.status === 'ready' ? datasets.data.filter((d) => d.status === 'active') : [];

  return (
    <PageFrame title="Overview" summary="Active incidents and the datasets being monitored.">
      <section className="panel overview-health" aria-labelledby="health-title">
        <h2 id="health-title" className="panel__title">
          Workspace health
        </h2>
        {active.status === 'ready' ? (
          <>
            <p className="overview-health__status">
              {criticalTotal > 0 ? (
                <StatusMark tone="critical" label={`${criticalTotal} critical incidents`} />
              ) : activeTotal > 0 ? (
                <StatusMark tone="warning" label={`${activeTotal} active incidents`} />
              ) : (
                <StatusMark tone="healthy" label="No active incidents" />
              )}
            </p>
            <div className="overview-health__metrics">
              <MetricBlock label="Active incidents" value={activeTotal} />
              <MetricBlock label="Critical incidents" value={criticalTotal} />
              <MetricBlock label="Datasets monitored" value={monitored.length} />
            </div>
          </>
        ) : active.status === 'error' ? (
          <ErrorState
            title="Could not load incidents"
            description={active.error.detail ?? active.error.message}
            onRetry={active.retry}
            retrying={active.retrying}
          />
        ) : (
          <p>Loading…</p>
        )}
      </section>

      <div className="panel">
        <DataTable
          caption="Active incidents"
          columns={incidentColumns}
          rows={active.status === 'ready' ? active.data.incidents : []}
          rowKey={(i) => i.id}
          empty={
            <EmptyState
              title="No active incidents"
              description="Every check is passing. New failures open an incident here."
            />
          }
        />
        {active.status === 'ready' && activeTotal > active.data.incidents.length && (
          <p>
            <Link to="/incidents">View all {activeTotal} active incidents</Link>
          </p>
        )}
      </div>

      <div className="panel">
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
            columns={datasetColumns}
            rows={datasets.status === 'ready' ? datasets.data : []}
            rowKey={(d) => d.id}
            empty={
              <EmptyState
                title="No datasets yet"
                description="Checks run against a data source. Connect PostgreSQL or upload a CSV to start monitoring."
              />
            }
          />
        )}
      </div>
    </PageFrame>
  );
}
