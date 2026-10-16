import { useState } from 'react';
import { DataTable } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import type { Severity } from '../components/SeverityBadge.tsx';
import { incidents, type IncidentStatus } from '../sample/sampleData.ts';
import { byPriority, incidentColumns } from './incidentTable.tsx';
import './IncidentsPage.css';

const statuses: IncidentStatus[] = ['Open', 'Acknowledged', 'Resolved'];
const severities: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

export function IncidentsPage() {
  const [status, setStatus] = useState<IncidentStatus | 'all'>('all');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');

  const shown = byPriority(
    incidents.filter(
      (i) =>
        (status === 'all' || i.status === status) &&
        (severity === 'all' || i.severity === severity),
    ),
  );

  return (
    <PageFrame
      title="Incidents"
      summary="Failed checks grouped into incidents. Most severe and oldest first."
      sample
    >
      <form className="filters" aria-label="Filter incidents" onSubmit={(e) => e.preventDefault()}>
        <label className="filters__field">
          Status
          <select
            className="text-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as IncidentStatus | 'all')}
          >
            <option value="all">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="filters__field">
          Severity
          <select
            className="text-input"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity | 'all')}
          >
            <option value="all">All severities</option>
            {severities.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </form>

      <DataTable
        caption="Incidents"
        columns={incidentColumns}
        rows={shown}
        rowKey={(i) => i.id}
        empty={
          <EmptyState
            title="No incidents match these filters"
            description="Try a different status or severity, or clear the filters to see every incident."
            action={
              <button
                type="button"
                className="button"
                onClick={() => {
                  setStatus('all');
                  setSeverity('all');
                }}
              >
                Clear filters
              </button>
            }
          />
        }
      />
    </PageFrame>
  );
}
