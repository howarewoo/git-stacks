import { useState } from 'react'
import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'
import { Button } from './button'

const features = tableFeatures({
  rowPaginationFeature,
  rowSortingFeature,
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
})
export interface DataTableProps<TData extends Record<string, string>> {
  columns: { accessorKey: keyof TData & string; header: string }[]
  data: TData[]
  emptyMessage?: string
}
/** Shared adaptation of shadcn's Base UI Data Table recipe using TanStack v9. */
export function DataTable<TData extends Record<string, string>>({
  columns,
  data,
  emptyMessage = 'No results.',
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const helper = createColumnHelper<typeof features, TData>()
  const table = useTable({
    features,
    data,
    columns: helper.columns(
      columns.map((column) =>
        helper.accessor((row) => row[column.accessorKey], {
          id: column.accessorKey,
          header: column.header,
        }),
      ),
    ),
    state: { sorting },
    onSortingChange: setSorting,
  })
  return (
    <div>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {!header.isPlaceholder && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          header.column.toggleSorting(header.column.getIsSorted() === 'asc')
                        }
                      >
                        <table.FlexRender header={header} />
                        {header.column.getIsSorted() === 'asc'
                          ? ' ↑'
                          : header.column.getIsSorted() === 'desc'
                            ? ' ↓'
                            : ''}
                      </Button>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex gap-2 py-3">
        <Button
          variant="secondary"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          Previous page
        </Button>
        <Button
          variant="secondary"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          Next page
        </Button>
      </div>
    </div>
  )
}
