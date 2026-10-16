import { useState } from 'react';
import { ConfirmActionDialog } from '../components/ConfirmActionDialog.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { MetricBlock } from '../components/MetricBlock.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import './ComponentGallery.css';

// Development-only gallery of every component state, with sample data.

interface SampleDataset {
  id: string;
  name: string;
  rows: number;
  health: 'healthy' | 'warning' | 'critical';
}

const datasets: SampleDataset[] = [
  { id: '1', name: 'orders_daily', rows: 2140, health: 'critical' },
  { id: '2', name: 'customers', rows: 98_412, health: 'healthy' },
  { id: '3', name: 'invoices_eu', rows: 7_310, health: 'warning' },
];

const healthLabel = { healthy: 'Healthy', warning: 'Stale', critical: 'Failing' } as const;

const columns: Column<SampleDataset>[] = [
  { key: 'name', header: 'Dataset', cell: (d) => d.name, sortValue: (d) => d.name },
  {
    key: 'health',
    header: 'Health',
    cell: (d) => <StatusMark tone={d.health} label={healthLabel[d.health]} />,
  },
  {
    key: 'rows',
    header: 'Rows',
    cell: (d) => d.rows.toLocaleString('en-US'),
    sortValue: (d) => d.rows,
    numeric: true,
  },
];

export function ComponentGallery() {
  const [dialog, setDialog] = useState<'retry' | 'purge' | undefined>();

  return (
    <PageFrame
      title="Components"
      summary="Development preview of every component state. All values are sample data."
    >
      <section className="gallery__section">
        <h2>Status and severity</h2>
        <div className="gallery__row">
          <StatusMark tone="healthy" label="Healthy" />
          <StatusMark tone="warning" label="Stale" />
          <StatusMark tone="critical" label="Failing" />
          <StatusMark tone="info" label="Running" />
          <StatusMark tone="neutral" label="Paused" />
        </div>
        <div className="gallery__row">
          <SeverityBadge severity="critical" />
          <SeverityBadge severity="warning" />
          <SeverityBadge severity="info" />
        </div>
      </section>

      <section className="gallery__section">
        <h2>Metrics</h2>
        <div className="gallery__metrics">
          <MetricBlock
            label="Rows loaded"
            value={2140}
            expected={{ min: 7000 }}
            window="Run at 06:10 today"
          />
          <MetricBlock label="Null rate, email" value={0.4} unit="%" expected={{ max: 2 }} />
          <MetricBlock label="Hours since last update" value={3} window="Checked 8 minutes ago" />
        </div>
      </section>

      <section className="gallery__section">
        <h2>Table</h2>
        <DataTable
          caption="Datasets"
          columns={columns}
          rows={datasets}
          rowKey={(d) => d.id}
          empty="No datasets yet."
        />
        <DataTable
          caption="Pipeline runs"
          columns={columns}
          rows={[]}
          rowKey={(d) => d.id}
          status="loading"
          empty=""
        />
        <DataTable
          caption="Check history"
          columns={columns}
          rows={[]}
          rowKey={(d) => d.id}
          status="error"
          errorMessage="Could not load check history. Reload the page to try again."
          empty=""
        />
      </section>

      <section className="gallery__section">
        <h2>Empty state</h2>
        <EmptyState
          title="No data sources yet"
          description="Checks run against a data source. Connect PostgreSQL or upload a CSV to start monitoring."
          action={
            <button type="button" className="button button--primary">
              Add a data source
            </button>
          }
        />
      </section>

      <section className="gallery__section">
        <h2>Confirmation</h2>
        <div className="gallery__row">
          <button type="button" className="button" onClick={() => setDialog('retry')}>
            Retry validation run
          </button>
          <button type="button" className="button" onClick={() => setDialog('purge')}>
            Purge source
          </button>
        </div>
        <ConfirmActionDialog
          open={dialog === 'retry'}
          title="Retry validation run"
          target="orders_daily"
          effect="Runs all enabled rules for this dataset again. Results replace nothing; they are added to the history."
          permission="Data engineer or above"
          confirmLabel="Retry run"
          onConfirm={() =>
            new Promise((resolve) => setTimeout(resolve, 800)).then(() => setDialog(undefined))
          }
          onCancel={() => setDialog(undefined)}
        />
        <ConfirmActionDialog
          open={dialog === 'purge'}
          title="Purge archived source"
          target="legacy_orders_db"
          effect="Permanently deletes stored credentials and uploaded files. Incidents, check results, and audit records are kept."
          permission="Owner or Administrator"
          confirmLabel="Purge source"
          confirmText="legacy_orders_db"
          onConfirm={() => Promise.reject(new Error('sample failure'))}
          onCancel={() => setDialog(undefined)}
        />
      </section>
    </PageFrame>
  );
}
