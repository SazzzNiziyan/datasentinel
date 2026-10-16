import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { MetricBlock } from '../components/MetricBlock.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { activity, datasets, incidents, type Dataset } from '../sample/sampleData.ts';
import { byPriority, incidentColumns } from './incidentTable.tsx';
import './OverviewPage.css';

const freshnessColumns: Column<Dataset>[] = [
  { key: 'name', header: 'Dataset', cell: (d) => d.name, sortValue: (d) => d.name },
  { key: 'health', header: 'Health', cell: (d) => <StatusMark {...d.health} /> },
  { key: 'freshness', header: 'Last update', cell: (d) => d.freshness },
  { key: 'next', header: 'Next check', cell: (d) => d.nextCheck },
];

export function OverviewPage() {
  const active = byPriority(incidents.filter((i) => i.status !== 'Resolved'));
  const failing = datasets.filter((d) => d.health.tone === 'critical').length;
  const stale = datasets.filter((d) => d.health.tone === 'warning').length;

  return (
    <PageFrame title="Overview" summary="Last 24 hours. Refreshed today at 08:42 UTC." sample>
      <section className="panel overview-health" aria-labelledby="health-title">
        <h2 id="health-title" className="panel__title">
          Workspace health
        </h2>
        <p className="overview-health__status">
          {failing > 0 ? (
            <StatusMark tone="critical" label={`${failing} datasets failing checks`} />
          ) : (
            <StatusMark tone="healthy" label="All checks passing" />
          )}
        </p>
        <div className="overview-health__metrics">
          <MetricBlock label="Datasets failing" value={failing} />
          <MetricBlock label="Datasets stale" value={stale} />
          <MetricBlock label="Datasets monitored" value={datasets.length} />
        </div>
      </section>

      <div className="panel span-8">
        <DataTable
          caption="Active incidents"
          columns={incidentColumns}
          rows={active}
          rowKey={(i) => i.id}
          empty={
            <EmptyState
              title="No active incidents"
              description="Every check is passing. New failures open an incident here."
            />
          }
        />
      </div>

      <section className="panel span-4" aria-labelledby="activity-title">
        <h2 id="activity-title" className="panel__title">
          Recent activity
        </h2>
        <Timeline label="Recent activity" events={activity} />
      </section>

      <div className="panel">
        <DataTable
          caption="Dataset freshness"
          columns={freshnessColumns}
          rows={datasets}
          rowKey={(d) => d.id}
          empty={
            <EmptyState
              title="No datasets yet"
              description="Checks run against a data source. Connect PostgreSQL or upload a CSV to start monitoring."
            />
          }
        />
      </div>
    </PageFrame>
  );
}
