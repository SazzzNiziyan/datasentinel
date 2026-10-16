import { DataTable, type Column } from '../components/DataTable.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageFrame } from '../components/PageFrame.tsx';
import { StatusMark } from '../components/StatusMark.tsx';
import { datasets, type Dataset } from '../sample/sampleData.ts';

const columns: Column<Dataset>[] = [
  { key: 'name', header: 'Dataset', cell: (d) => d.name, sortValue: (d) => d.name },
  { key: 'source', header: 'Source', cell: (d) => d.source, sortValue: (d) => d.source },
  { key: 'health', header: 'Health', cell: (d) => <StatusMark {...d.health} /> },
  {
    key: 'rows',
    header: 'Rows',
    cell: (d) => d.rows.toLocaleString('en-US'),
    sortValue: (d) => d.rows,
    numeric: true,
  },
  { key: 'freshness', header: 'Last update', cell: (d) => d.freshness },
  { key: 'profile', header: 'Last profile', cell: (d) => d.lastProfile },
];

export function DatasetsPage() {
  return (
    <PageFrame
      title="Datasets"
      summary="Profiles, rules, schema history, and check results for each dataset."
      sample
    >
      <DataTable
        caption="Datasets"
        columns={columns}
        rows={datasets}
        rowKey={(d) => d.id}
        empty={
          <EmptyState
            title="No datasets yet"
            description="Datasets appear after a data source is connected and checked."
          />
        }
      />
    </PageFrame>
  );
}
