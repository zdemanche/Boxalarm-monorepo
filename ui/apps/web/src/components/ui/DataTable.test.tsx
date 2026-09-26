import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './DataTable';

afterEach(cleanup);

interface Row {
  id: string;
  unitId: string;
  type: string;
}

const rows: Row[] = [
  { id: '1', unitId: 'Engine 301', type: 'Engine' },
  { id: '2', unitId: 'Ladder 12', type: 'Ladder' },
  { id: '3', unitId: 'Brush 4', type: 'Brush' },
];

const columns: DataTableColumn<Row>[] = [
  { key: 'unitId', header: 'Unit', sortValue: (r) => r.unitId, render: (r) => r.unitId },
  { key: 'type', header: 'Type', render: (r) => r.type },
];

function renderTable(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable
      caption="Apparatus registry"
      rowKey={(r) => r.id}
      columns={columns}
      rows={rows}
      {...props}
    />,
  );
}

describe('DataTable', () => {
  test('renders a header per column and one row per item', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Unit' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeTruthy();
    expect(screen.getByText('Engine 301')).toBeTruthy();
    expect(screen.getByText('Ladder 12')).toBeTruthy();
    expect(screen.getByText('Brush 4')).toBeTruthy();
  });

  test('a column with no sortValue renders as plain text, not a sort button', () => {
    renderTable();
    const typeHeader = screen.getByRole('columnheader', { name: 'Type' });
    expect(within(typeHeader).queryByRole('button')).toBeNull();
  });

  test('sort cycle: unsorted -> ascending -> descending -> unsorted', async () => {
    const user = userEvent.setup();
    renderTable();
    const sortButton = screen.getByRole('button', { name: 'Unit' });
    const unitHeader = screen.getByRole('columnheader', { name: 'Unit' });

    expect(unitHeader.getAttribute('aria-sort')).toBeNull();

    await user.click(sortButton);
    expect(unitHeader.getAttribute('aria-sort')).toBe('ascending');
    let cells = screen.getAllByRole('row').slice(1); // drop the header row
    expect(within(cells[0]!).getByText('Brush 4')).toBeTruthy();

    await user.click(sortButton);
    expect(unitHeader.getAttribute('aria-sort')).toBe('descending');
    cells = screen.getAllByRole('row').slice(1);
    expect(within(cells[0]!).getByText('Ladder 12')).toBeTruthy();

    await user.click(sortButton);
    expect(unitHeader.getAttribute('aria-sort')).toBeNull();
    // Back to the original, unsorted row order.
    cells = screen.getAllByRole('row').slice(1);
    expect(within(cells[0]!).getByText('Engine 301')).toBeTruthy();
  });

  test('loading renders a busy skeleton, not the rows', () => {
    renderTable({ loading: true });
    expect(screen.queryByText('Engine 301')).toBeNull();
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).toBeTruthy();
  });

  test('error renders the message in an alert region, not the rows', () => {
    renderTable({ error: 'Could not load apparatus.' });
    expect(screen.queryByText('Engine 301')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Could not load apparatus.');
  });

  test('empty renders the emptyMessage', () => {
    renderTable({ rows: [], emptyMessage: 'No apparatus yet.' });
    expect(screen.getByText('No apparatus yet.')).toBeTruthy();
  });
});

// s1 (PR #321 review): the sort is memoised, so re-rendering with the same rows/columns/sort
// doesn't re-sort the whole row set.
test('does not re-sort on a re-render with unchanged inputs', async () => {
  const sortValue = vi.fn((r: Row) => r.unitId);
  const memoColumns: DataTableColumn<Row>[] = [
    { key: 'unitId', header: 'Unit', sortValue, render: (r) => r.unitId },
  ];
  const user = userEvent.setup();
  const view = render(
    <DataTable caption="t" rowKey={(r) => r.id} columns={memoColumns} rows={rows} />,
  );
  await user.click(screen.getByRole('button', { name: /Unit/ }));
  const callsAfterSort = sortValue.mock.calls.length;
  expect(callsAfterSort).toBeGreaterThan(0);

  view.rerender(<DataTable caption="t" rowKey={(r) => r.id} columns={memoColumns} rows={rows} />);
  expect(sortValue.mock.calls.length).toBe(callsAfterSort);
});
