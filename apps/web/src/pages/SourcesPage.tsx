import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { sources, type Source } from '../sample/sampleData.ts';

const columns: Column<Source>[] = [
  { key: 'name', header: 'Source', cell: (s) => s.name, sortValue: (s) => s.name },
  { key: 'type', header: 'Type', cell: (s) => s.type, sortValue: (s) => s.type },
  { key: 'status', header: 'Status', cell: (s) => <StatusMark {...s.status} /> },
  { key: 'lastCheck', header: 'Last check', cell: (s) => s.lastCheck },
  { key: 'owner', header: 'Owner', cell: (s) => s.owner, sortValue: (s) => s.owner },
  { key: 'schedule', header: 'Schedule', cell: (s) => s.schedule },
];

export function SourcesPage() {
  return (
    <PageFrame
      title="Data sources"
      summary="CSV uploads, PostgreSQL connections, and API checks, with their health."
      sample
    >
      <DataTable
        caption="Data sources"
        columns={columns}
        rows={sources}
        rowKey={(s) => s.id}
        empty={
          <EmptyState
            title="No data sources yet"
            description="Checks run against a data source. Connect PostgreSQL or upload a CSV to start monitoring."
          />
        }
      />
    </PageFrame>
  );
}
