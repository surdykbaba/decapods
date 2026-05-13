// Shared sorting + pagination primitives for every list/table view in the
// app. Five tables had ad-hoc copies of "Rows selector + Prev / Next +
// page indicator" before this; centralising them keeps the controls
// pixel-identical across the product and means a UX tweak only has to
// land in one place.

import { useEffect, useMemo, useState } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";

export type SortDir = "asc" | "desc";
export type SortState<K extends string> = { col: K; dir: SortDir };

// Standard rows-per-page menu used across the app. 0 means "show all"
// (paged components clamp this to a safe upper bound).
export const STANDARD_PAGE_SIZES = [10, 20, 30, 50, 100, 0] as const;

// usePagedSort — single hook that owns sort + page state for a table.
//   • Persists page size in localStorage under the caller-supplied key so
//     the choice survives navigation.
//   • Resets the page index when filters / sort / page size change so the
//     table never sits on a stale empty page.
//   • Clamps page index inside render so a delete from the last row
//     doesn't strand the user on a non-existent page.
//
// The caller passes their compare function for the active sort column —
// keeping the actual ordering logic at the call site (since it depends on
// the row shape) while the wiring lives here once.
export function usePagedSort<Row, K extends string>(opts: {
  rows: Row[];
  storageKey: string;
  defaultSort: SortState<K>;
  compare: (a: Row, b: Row, sort: SortState<K>) => number;
  // Bumping any value in `resetOn` resets the page index to 0. Useful for
  // filter changes that shouldn't strand the user on page 5 of nothing.
  resetOn?: unknown[];
  pageSizes?: readonly number[];
}) {
  const pageSizes = opts.pageSizes ?? STANDARD_PAGE_SIZES;
  const [sort, setSort] = useState<SortState<K>>(opts.defaultSort);
  const [pageSize, setPageSize] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(opts.storageKey) ?? "20", 10);
    return Number.isFinite(v) ? v : 20;
  });
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [pageSize, sort.col, sort.dir, opts.rows.length, ...(opts.resetOn ?? [])]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickPageSize(n: number) {
    setPageSize(n);
    localStorage.setItem(opts.storageKey, String(n));
  }

  function toggleSort(col: K, defaultDir: SortDir = "desc") {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: defaultDir },
    );
  }

  const sorted = useMemo(() => {
    const xs = [...opts.rows];
    xs.sort((a, b) => opts.compare(a, b, sort));
    return xs;
  }, [opts.rows, sort, opts.compare]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = sorted.length;
  const effectivePageSize = pageSize === 0 ? Math.max(1, total) : pageSize;
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => (pageSize === 0 ? sorted : sorted.slice(safePage * pageSize, safePage * pageSize + pageSize)),
    [sorted, safePage, pageSize],
  );
  const firstShown = total === 0 ? 0 : pageSize === 0 ? 1 : safePage * pageSize + 1;
  const lastShown  = pageSize === 0 ? total : Math.min(total, safePage * pageSize + pageSize);

  return {
    sort, setSort, toggleSort,
    pageSize, pickPageSize,
    page: safePage, setPage,
    pageRows, total, totalPages, firstShown, lastShown,
    pageSizes,
  };
}

// SortHeader — drop-in replacement for a static <th>. Renders the column
// label as a click target with an asc/desc arrow when active and a faint
// up-arrow as a hint when inactive. Caller provides the column key
// vocabulary so the arrows are type-checked.
export function SortHeader<K extends string>({
  col, label, sort, onSort, className = "", align = "left",
}: {
  col: K;
  label: string;
  sort: SortState<K>;
  onSort: (col: K) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const active = sort.col === col;
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <th className={`px-4 py-2 font-semibold select-none ${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"} ${className}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-text transition-colors ${justify} ${
          active ? "text-accent" : "text-muted"
        }`}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active
          ? (sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)
          : <ArrowUp size={10} className="opacity-30" />}
      </button>
    </th>
  );
}

// TablePager — Rows selector + Prev / Next + "Showing 1–20 of 35 X". Lives
// underneath whatever it's pagging. Identical visual treatment everywhere
// so the muscle memory transfers between Members / Projects / Invoices /
// etc.
export function TablePager({
  total, pageSize, pickPageSize, page, setPage, totalPages,
  firstShown, lastShown, pageSizes = STANDARD_PAGE_SIZES,
  label = "row",
}: {
  total: number;
  pageSize: number;
  pickPageSize: (n: number) => void;
  page: number;
  setPage: (n: number | ((p: number) => number)) => void;
  totalPages: number;
  firstShown: number;
  lastShown: number;
  pageSizes?: readonly number[];
  // Singular noun for the "Showing 1–20 of 35 rows" sentence. We pluralise
  // by appending "s" unless the count is exactly one.
  label?: string;
}) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border bg-bg/30 text-xs flex-wrap">
      <div className="text-muted inline-flex items-center gap-3 flex-wrap">
        <span>
          Showing <span className="font-semibold text-text">{firstShown}</span>–
          <span className="font-semibold text-text">{lastShown}</span> of{" "}
          <span className="font-semibold text-text">{total.toLocaleString()}</span> {label}{total === 1 ? "" : "s"}
        </span>
        <label className="inline-flex items-center gap-1.5">
          Rows
          <select
            value={pageSize}
            onChange={(e) => pickPageSize(parseInt(e.target.value, 10))}
            className="bg-surface border border-border rounded-lg px-2 py-1 text-[12px] font-semibold text-text"
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>{n === 0 ? "All" : n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0 || pageSize === 0}
          className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
        >
          ← Prev
        </button>
        <span className="text-muted px-1">
          Page <span className="font-semibold text-text">{pageSize === 0 ? 1 : page + 1}</span> of{" "}
          <span className="font-semibold text-text">{pageSize === 0 ? 1 : totalPages}</span>
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={pageSize === 0 || page + 1 >= totalPages}
          className="px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-bg/40 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-text"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
