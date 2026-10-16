import type { Column } from '../components/DataTable.tsx';
import { SeverityBadge } from '../components/SeverityBadge.tsx';
import type { Incident } from '../sample/sampleData.ts';

const severityRank = { critical: 0, warning: 1, info: 2 } as const;

/** Most severe first; within a severity, the oldest first, because it has
 * waited longest (docs/06-design-system.md, Dashboard). */
export function byPriority(incidents: readonly Incident[]): Incident[] {
  return [...incidents].sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] || a.openedAt.localeCompare(b.openedAt),
  );
}

const opened = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export const incidentColumns: Column<Incident>[] = [
  { key: 'severity', header: 'Severity', cell: (i) => <SeverityBadge severity={i.severity} /> },
  {
    key: 'title',
    header: 'Incident',
    cell: (i) => (
      <>
        {i.title} <span className="mono">{i.id}</span>
      </>
    ),
  },
  { key: 'dataset', header: 'Dataset', cell: (i) => i.dataset, sortValue: (i) => i.dataset },
  {
    key: 'opened',
    header: 'Opened',
    cell: (i) => `${opened.format(new Date(i.openedAt))} UTC`,
    sortValue: (i) => i.openedAt,
  },
  { key: 'owner', header: 'Owner', cell: (i) => i.owner, sortValue: (i) => i.owner },
  { key: 'status', header: 'Status', cell: (i) => i.status, sortValue: (i) => i.status },
];
