import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DataTable, type Column, type DataTableProps } from '../../src/components/DataTable.tsx';

interface Row {
  id: string;
  name: string;
  rows: number;
}
const data: Row[] = [
  { id: 'a', name: 'orders_daily', rows: 2140 },
  { id: 'b', name: 'customers', rows: 98000 },
  { id: 'c', name: 'invoices', rows: 450 },
];
const columns: Column<Row>[] = [
  { key: 'name', header: 'Dataset', cell: (r) => r.name, sortValue: (r) => r.name },
  { key: 'rows', header: 'Rows', cell: (r) => r.rows, sortValue: (r) => r.rows },
];

function table(props: Partial<DataTableProps<Row>> = {}) {
  return render(
    <DataTable
      caption="Datasets"
      columns={columns}
      rows={data}
      rowKey={(r) => r.id}
      empty="No datasets yet."
      {...props}
    />,
  );
}

const bodyNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

describe('DataTable', () => {
  it('renders a captioned table with headers and cells', () => {
    table();
    expect(screen.getByRole('table', { name: 'Datasets' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: /Dataset/ })).toBeVisible();
    expect(bodyNames()).toEqual(['orders_daily', 'customers', 'invoices']);
  });

  it('sorts by a column, then reverses on a second click', async () => {
    const user = userEvent.setup();
    table();
    const header = screen.getByRole('columnheader', { name: /Rows/ });
    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['invoices', 'orders_daily', 'customers']);
    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(bodyNames()).toEqual(['customers', 'orders_daily', 'invoices']);
  });

  it('announces loading and marks the table busy', () => {
    table({ status: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows a loading error as an alert', () => {
    table({ status: 'error', errorMessage: 'Could not load datasets. Try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load datasets. Try again.');
  });

  it('marks a loading error as critical, unlike the loading message', () => {
    table({ status: 'error', errorMessage: 'Could not load datasets. Try again.' });
    expect(screen.getByRole('alert').querySelector('[data-shape="square"]')).not.toBeNull();
  });

  it('shows the empty content when there are no rows', () => {
    table({ rows: [] });
    expect(screen.getByText('No datasets yet.')).toBeVisible();
  });
});
