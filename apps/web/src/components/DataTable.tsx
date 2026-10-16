import { useId, useState, type ReactNode } from 'react';
import { StatusMark } from './StatusMark.tsx';
import './DataTable.css';

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** Makes the column sortable. */
  sortValue?: (row: Row) => string | number;
  /** Right-align numbers so digits line up. */
  numeric?: boolean;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  status?: 'loading' | 'error' | 'ready';
  /** Shown when status is "error": what failed and what to do. */
  errorMessage?: string;
  /** Shown when there are no rows. Usually an EmptyState. */
  empty: ReactNode;
}

type Sort = { key: string; direction: 'ascending' | 'descending' } | undefined;

function compare(a: string | number, b: string | number): number {
  return typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b));
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  status = 'ready',
  errorMessage = 'Could not load this table.',
  empty,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<Sort>();
  const captionId = useId();

  const sortValue = columns.find((column) => column.key === sort?.key)?.sortValue;
  const sorted =
    sortValue === undefined
      ? rows
      : [...rows].sort((a, b) => {
          const order = compare(sortValue(a), sortValue(b));
          return sort?.direction === 'descending' ? -order : order;
        });

  const toggle = (key: string) =>
    setSort((current) => ({
      key,
      direction:
        current?.key === key && current.direction === 'ascending' ? 'descending' : 'ascending',
    }));

  let body: ReactNode;
  if (status === 'loading') {
    body = (
      <tr>
        <td colSpan={columns.length} className="data-table__message">
          <span role="status">Loading {caption}…</span>
        </td>
      </tr>
    );
  } else if (status === 'error') {
    body = (
      <tr>
        <td colSpan={columns.length} className="data-table__message data-table__message--error">
          <span role="alert">
            <StatusMark tone="critical" label={errorMessage} />
          </span>
        </td>
      </tr>
    );
  } else if (rows.length === 0) {
    body = (
      <tr>
        <td colSpan={columns.length} className="data-table__message">
          {empty}
        </td>
      </tr>
    );
  } else {
    body = sorted.map((row) => (
      <tr key={rowKey(row)}>
        {columns.map((column) => (
          <td key={column.key} data-numeric={column.numeric === true || undefined}>
            {column.cell(row)}
          </td>
        ))}
      </tr>
    ));
  }

  return (
    // Focusable so keyboard users can scroll a wide table on narrow screens.
    <div className="data-table" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table aria-busy={status === 'loading'}>
        <caption id={captionId} className="data-table__caption">
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const direction = sort?.key === column.key ? sort.direction : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={direction}
                  data-numeric={column.numeric === true || undefined}
                >
                  {column.sortValue === undefined ? (
                    column.header
                  ) : (
                    <button
                      type="button"
                      className="data-table__sort"
                      onClick={() => toggle(column.key)}
                    >
                      {column.header}
                      <span className="data-table__sort-mark" aria-hidden="true">
                        {direction === 'ascending' ? '▲' : direction === 'descending' ? '▼' : '△'}
                      </span>
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
