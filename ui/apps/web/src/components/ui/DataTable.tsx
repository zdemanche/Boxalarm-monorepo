import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from './icons';
import { Skeleton } from './Skeleton';
import styles from './DataTable.module.css';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  isRowHeader?: boolean;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  density?: 'comfortable' | 'dense';
  loading?: boolean;
  error?: ReactNode;
  emptyMessage?: ReactNode;
  caption: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  density = 'comfortable',
  loading = false,
  error,
  emptyMessage = 'No results.',
  caption,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  // Memoised so an unrelated parent re-render doesn't re-sort the whole row set (PR #321 s1).
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const sortValue = col?.sortValue;
    if (!sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, columns, sort]);

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' };
      return prev.dir === 'asc' ? { key, dir: 'desc' } : null;
    });
  };

  return (
    <div className={styles.wrapper} role="region" aria-label={caption} tabIndex={0}>
      <table className={[styles.table, styles[density]].join(' ')}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={
                  sort?.key === col.key
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                style={{ textAlign: col.align ?? 'left' }}
              >
                {col.sortValue ? (
                  <button
                    type="button"
                    className={styles.sortButton}
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.header}
                    {sort?.key === col.key ? (
                      sort.dir === 'asc' ? (
                        <ArrowUp size={12} aria-hidden="true" />
                      ) : (
                        <ArrowDown size={12} aria-hidden="true" />
                      )
                    ) : null}
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr className={styles.stateRow}>
              <td colSpan={columns.length}>
                <Skeleton lines={4} />
              </td>
            </tr>
          ) : error ? (
            <tr className={styles.stateRow}>
              <td colSpan={columns.length} role="alert">
                {error}
              </td>
            </tr>
          ) : sortedRows.length === 0 ? (
            <tr className={styles.stateRow}>
              <td colSpan={columns.length}>{emptyMessage}</td>
            </tr>
          ) : (
            sortedRows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((col) =>
                  col.isRowHeader ? (
                    <th key={col.key} scope="row" style={{ textAlign: col.align ?? 'left' }}>
                      {col.render(row)}
                    </th>
                  ) : (
                    <td key={col.key} style={{ textAlign: col.align ?? 'left' }}>
                      {col.render(row)}
                    </td>
                  ),
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
