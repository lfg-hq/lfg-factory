# Data Tables

## When to Use This

Use these patterns for any list-based data interface: admin dashboards, CRM records, order history, user management, inventory. These patterns handle large data sets with sorting, filtering, pagination, and bulk actions.

## Quick Start

### Dependencies

```bash
npm install @tanstack/react-table
# Optional: for icons
npm install lucide-react
```

### Key Principles

- Use `@tanstack/react-table` (TanStack Table v8) for complex tables — it handles sorting, filtering, and pagination state
- For simple tables without sort/filter, plain JSX with `useState` is sufficient
- Always provide an empty state — never render an empty `<tbody>`
- Always provide a loading skeleton with the same column count as the real table
- Wrap tables in `overflow-x-auto` for horizontal scroll on mobile
- Use `aria-sort` on sortable column headers for accessibility
- Bulk selection should show a contextual action bar, not a floating dropdown

## Patterns

### 1. Sortable Table with TanStack Table

```tsx
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "active" | "inactive" | "pending";
  createdAt: string;
};

const STATUS_STYLES: Record<User["status"], string> = {
  active: "bg-green-100 text-green-700",
  inactive: "bg-gray-100 text-gray-600",
  pending: "bg-yellow-100 text-yellow-700",
};

const columnHelper = createColumnHelper<User>();

const columns = [
  columnHelper.accessor("name", {
    header: "Name",
    cell: (info) => (
      <div className="font-medium text-gray-900">{info.getValue()}</div>
    ),
  }),
  columnHelper.accessor("email", {
    header: "Email",
    cell: (info) => <div className="text-gray-500">{info.getValue()}</div>,
  }),
  columnHelper.accessor("role", { header: "Role" }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => (
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize
          ${STATUS_STYLES[info.getValue()]}`}
      >
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor("createdAt", {
    header: "Created",
    cell: (info) =>
      new Date(info.getValue()).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
  }),
];

function SortIcon({ direction }: { direction: "asc" | "desc" | false }) {
  if (!direction) {
    return (
      <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    );
  }
  return (
    <svg
      className={`h-3.5 w-3.5 text-blue-600 transition ${direction === "desc" ? "rotate-180" : ""}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

export function SortableTable({ data }: { data: User[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  aria-sort={
                    header.column.getIsSorted() === "asc"
                      ? "ascending"
                      : header.column.getIsSorted() === "desc"
                      ? "descending"
                      : "none"
                  }
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                >
                  {header.column.getCanSort() ? (
                    <button
                      onClick={header.column.getToggleSortingHandler()}
                      className="flex items-center gap-1.5 hover:text-gray-900 transition"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <SortIcon direction={header.column.getIsSorted()} />
                    </button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="hover:bg-gray-50 transition">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### 2. Pagination Controls

```tsx
import { useState } from "react";

interface PaginationProps {
  totalItems: number;
  pageSize: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

const PAGE_SIZES = [10, 25, 50, 100];

export function Pagination({
  totalItems,
  pageSize,
  currentPage,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const totalPages = Math.ceil(totalItems / pageSize);
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  // Build visible page numbers with ellipsis
  function getPageNumbers(): (number | "...")[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (currentPage <= 4) return [1, 2, 3, 4, 5, "...", totalPages];
    if (currentPage >= totalPages - 3) {
      return [1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    }
    return [1, "...", currentPage - 1, currentPage, currentPage + 1, "...", totalPages];
  }

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-4 py-3 border-t border-gray-200">
      <div className="flex items-center gap-4 text-sm text-gray-600">
        <span>
          Showing <span className="font-medium text-gray-900">{start}</span>–
          <span className="font-medium text-gray-900">{end}</span> of{" "}
          <span className="font-medium text-gray-900">{totalItems}</span> results
        </span>
        {onPageSizeChange && (
          <div className="flex items-center gap-2">
            <span>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                onPageSizeChange(Number(e.target.value));
                onPageChange(1);
              }}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm outline-none
                focus:ring-2 focus:ring-blue-500"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <nav aria-label="Pagination" className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          aria-label="Previous page"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500
            hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {getPageNumbers().map((page, i) =>
          page === "..." ? (
            <span key={`ellipsis-${i}`} className="flex h-8 w-8 items-center justify-center text-sm text-gray-400">
              &hellip;
            </span>
          ) : (
            <button
              key={page}
              onClick={() => onPageChange(page as number)}
              aria-label={`Page ${page}`}
              aria-current={currentPage === page ? "page" : undefined}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-medium transition
                ${currentPage === page
                  ? "bg-blue-600 text-white shadow-sm"
                  : "border border-gray-200 text-gray-700 hover:bg-gray-50"
                }`}
            >
              {page}
            </button>
          )
        )}

        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          aria-label="Next page"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500
            hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </nav>
    </div>
  );
}
```

### 3. Search and Filter Bar

```tsx
import { useState, useCallback } from "react";

type FilterState = {
  search: string;
  status: string;
  role: string;
};

interface TableToolbarProps {
  onFilterChange: (filters: FilterState) => void;
  totalSelected?: number;
  onBulkDelete?: () => void;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useCallback(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay])();
  return debounced;
}

export function TableToolbar({ onFilterChange, totalSelected = 0, onBulkDelete }: TableToolbarProps) {
  const [filters, setFilters] = useState<FilterState>({
    search: "",
    status: "",
    role: "",
  });

  const update = (key: keyof FilterState, value: string) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    onFilterChange(next);
  };

  const hasFilters = filters.search || filters.status || filters.role;

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {totalSelected > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-blue-50 border border-blue-200 px-4 py-2">
          <span className="text-sm font-medium text-blue-700">
            {totalSelected} selected
          </span>
          <div className="flex-1" />
          {onBulkDelete && (
            <button
              onClick={onBulkDelete}
              className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white
                hover:bg-red-700 transition"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
            </button>
          )}
          <button
            className="text-xs text-blue-600 hover:underline"
            onClick={() => onFilterChange(filters)}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="search"
            placeholder="Search users..."
            value={filters.search}
            onChange={(e) => update("search", e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white pl-9 pr-4 py-2 text-sm outline-none
              focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {filters.search && (
            <button
              onClick={() => update("search", "")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <select
          value={filters.status}
          onChange={(e) => update("status", e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none
            focus:ring-2 focus:ring-blue-500 min-w-[140px]"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="pending">Pending</option>
        </select>

        <select
          value={filters.role}
          onChange={(e) => update("role", e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none
            focus:ring-2 focus:ring-blue-500 min-w-[140px]"
        >
          <option value="">All roles</option>
          <option value="admin">Admin</option>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>

        {hasFilters && (
          <button
            onClick={() => {
              const cleared = { search: "", status: "", role: "" };
              setFilters(cleared);
              onFilterChange(cleared);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm
              text-gray-600 hover:bg-gray-50 transition whitespace-nowrap"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
```

### 4. Row Actions Dropdown

```tsx
import { useState, useRef, useEffect } from "react";

type RowAction<T> = {
  label: string;
  icon?: React.ReactNode;
  onClick: (row: T) => void;
  variant?: "default" | "danger";
};

interface RowActionsProps<T> {
  row: T;
  actions: RowAction<T>[];
}

export function RowActions<T>({ row, actions }: RowActionsProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative flex justify-end">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400
          hover:bg-gray-100 hover:text-gray-700 transition"
      >
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 w-44 rounded-xl border border-gray-200 bg-white
            py-1 shadow-lg ring-1 ring-black ring-opacity-5"
        >
          {actions.map((action) => (
            <button
              key={action.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                action.onClick(row);
              }}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-sm transition
                ${action.variant === "danger"
                  ? "text-red-600 hover:bg-red-50"
                  : "text-gray-700 hover:bg-gray-50"
                }`}
            >
              {action.icon && (
                <span className="h-4 w-4 shrink-0">{action.icon}</span>
              )}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Usage example:
// <RowActions
//   row={user}
//   actions={[
//     { label: "Edit", icon: <PencilIcon />, onClick: (u) => openEdit(u) },
//     { label: "View profile", icon: <EyeIcon />, onClick: (u) => router.push(`/users/${u.id}`) },
//     { label: "Delete", icon: <TrashIcon />, onClick: (u) => confirmDelete(u), variant: "danger" },
//   ]}
// />
```

### 5. Bulk Selection with Checkbox

```tsx
import { useState, useCallback } from "react";

interface BulkSelectTableProps<T extends { id: string }> {
  data: T[];
  renderRow: (item: T, isSelected: boolean) => React.ReactNode;
  onBulkAction: (ids: string[], action: string) => void;
}

export function BulkSelectTable<T extends { id: string }>({
  data,
  renderRow,
  onBulkAction,
}: BulkSelectTableProps<T>) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const allSelected = data.length > 0 && selectedIds.size === data.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(data.map((d) => d.id)));
  }, [allSelected, data]);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="space-y-2">
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-blue-50 border border-blue-200 px-4 py-2.5">
          <span className="text-sm font-semibold text-blue-800">
            {selectedIds.size} row{selectedIds.size > 1 ? "s" : ""} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={() => {
              onBulkAction([...selectedIds], "export");
              setSelectedIds(new Set());
            }}
            className="rounded bg-white border border-blue-300 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 transition"
          >
            Export
          </button>
          <button
            onClick={() => {
              onBulkAction([...selectedIds], "delete");
              setSelectedIds(new Set());
            }}
            className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 transition"
          >
            Delete
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              {/* Add your column headers here */}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {data.map((item) => (
              <tr
                key={item.id}
                onClick={() => toggleOne(item.id)}
                className={`cursor-pointer transition ${
                  selectedIds.has(item.id) ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
              >
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggleOne(item.id)}
                    aria-label={`Select row ${item.id}`}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </td>
                {renderRow(item, selectedIds.has(item.id))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

### 6. Empty State

```tsx
interface EmptyStateProps {
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  hasFilters?: boolean;
  onClearFilters?: () => void;
}

export function TableEmptyState({
  title,
  description,
  action,
  hasFilters,
  onClearFilters,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 mb-4">
        {hasFilters ? (
          <svg className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        ) : (
          <svg className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        )}
      </div>
      <h3 className="text-base font-semibold text-gray-900 mb-1">{title}</h3>
      <p className="text-sm text-gray-500 max-w-sm mb-6">{description}</p>
      <div className="flex items-center gap-3">
        {hasFilters && onClearFilters && (
          <button
            onClick={onClearFilters}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700
              hover:bg-gray-50 transition"
          >
            Clear filters
          </button>
        )}
        {action && (
          <button
            onClick={action.onClick}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white
              hover:bg-blue-700 transition"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
```

### 7. Loading Skeleton

```tsx
function SkeletonCell({ className = "" }: { className?: string }) {
  return (
    <div className={`h-4 rounded bg-gray-200 animate-pulse ${className}`} />
  );
}

export function TableSkeleton({
  rows = 5,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="px-4 py-3">
                <SkeletonCell className={i === 0 ? "w-24" : "w-16"} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {Array.from({ length: rows }).map((_, rowIdx) => (
            <tr key={rowIdx}>
              {Array.from({ length: columns }).map((_, colIdx) => (
                <td key={colIdx} className="px-4 py-3.5">
                  {colIdx === 0 ? (
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-gray-200 animate-pulse shrink-0" />
                      <div className="space-y-1.5">
                        <SkeletonCell className="w-24" />
                        <SkeletonCell className="w-16 h-3" />
                      </div>
                    </div>
                  ) : (
                    <SkeletonCell
                      className={`w-${[20, 16, 12, 14][colIdx % 4]}`}
                      style={{ width: `${[80, 64, 48, 56][colIdx % 4]}px` }}
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### 8. Full Table with All Features Composed

```tsx
import { useState, useMemo } from "react";

type Item = { id: string; name: string; email: string; status: string; role: string };

export function FullFeaturedTable({ initialData }: { initialData: Item[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortField, setSortField] = useState<keyof Item>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading] = useState(false);

  const filtered = useMemo(() => {
    let rows = [...initialData];
    if (search) rows = rows.filter((r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.email.toLowerCase().includes(search.toLowerCase())
    );
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    rows.sort((a, b) => {
      const cmp = a[sortField] < b[sortField] ? -1 : a[sortField] > b[sortField] ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [initialData, search, statusFilter, sortField, sortDir]);

  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const handleSort = (field: keyof Item) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  if (isLoading) return <TableSkeleton rows={pageSize} columns={4} />;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex gap-3">
        <input
          type="search"
          placeholder="Search..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <TableEmptyState
          title="No results found"
          description="Try adjusting your search or filter to find what you're looking for."
          hasFilters={!!(search || statusFilter)}
          onClearFilters={() => { setSearch(""); setStatusFilter(""); }}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.size === paginated.length && paginated.length > 0}
                      onChange={() => {
                        if (selected.size === paginated.length) {
                          setSelected(new Set());
                        } else {
                          setSelected(new Set(paginated.map((r) => r.id)));
                        }
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    />
                  </th>
                  {(["name", "email", "status", "role"] as const).map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                    >
                      <button
                        onClick={() => handleSort(col)}
                        className="flex items-center gap-1 hover:text-gray-900 transition capitalize"
                      >
                        {col}
                        {sortField === col && (
                          <span className="text-blue-600">{sortDir === "asc" ? " ↑" : " ↓"}</span>
                        )}
                      </button>
                    </th>
                  ))}
                  <th scope="col" className="relative px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {paginated.map((row) => (
                  <tr key={row.id} className={`hover:bg-gray-50 transition ${selected.has(row.id) ? "bg-blue-50" : ""}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => {
                          const next = new Set(selected);
                          next.has(row.id) ? next.delete(row.id) : next.add(row.id);
                          setSelected(next);
                        }}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600"
                      />
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{row.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{row.email}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium
                        ${row.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 capitalize">{row.role}</td>
                    <td className="px-4 py-3">
                      <RowActions
                        row={row}
                        actions={[
                          { label: "Edit", onClick: (r) => console.log("edit", r) },
                          { label: "Delete", onClick: (r) => console.log("delete", r), variant: "danger" },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            totalItems={filtered.length}
            pageSize={pageSize}
            currentPage={page}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        </>
      )}
    </div>
  );
}
```

## Common Mistakes

- **Do not put all table logic in one giant component** — split toolbar, table, pagination, and row actions into separate components
- **Do not sort/filter on every render** — memoize with `useMemo`, keyed on the data and filter state
- **Do not forget to reset `page` to `1`** when search or filter changes — stale page numbers show empty results
- **Do not use row index as `key`** — use a stable unique ID; index keys break selection and animation
- **Do not hide the column headers on mobile** — use `overflow-x-auto` with horizontal scroll instead; hiding columns loses context
- **Do not make the whole row a link for tables with checkboxes** — it conflicts with checkbox clicks; use explicit row action buttons
- **Do not skip empty states** — an empty `<tbody>` with no message is confusing; always explain why the table is empty and offer a recovery path

## Framework-Specific Notes

### Next.js

- For server-side pagination, use `searchParams` in page components and pass them to your data fetching function — avoid client-side only state for pagination in SSR apps
- Use `loading.tsx` with a `<TableSkeleton />` for route-level loading states
- For large datasets, prefer React Server Components to fetch data; pass to a `"use client"` table component for interactivity

### React + Vite

- Use `@tanstack/react-query` alongside `@tanstack/react-table` for server-side pagination: `useQuery({ queryKey: ["users", page, search], queryFn: fetchUsers })`
- Keep filter state in the URL with a library like `nuqs` or manually with `URLSearchParams` so users can share filtered views
