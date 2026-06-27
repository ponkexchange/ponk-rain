"use client";

import { useMemo, useState } from "react";

import { PoolCard, type PoolListItem } from "@/components/pools/PoolCard";

/**
 * Client-side browser for a set of discovered Ponk Clouds pools: a search box,
 * a sortable column header, and a list of {@link PoolCard} rows with an honest
 * empty state.
 *
 * The list is given the pools as a prop (the server component fetches the first
 * page of `GET /clouds/pools`); sorting and searching happen in the browser
 * over that set so the home page stays snappy without extra round trips. The
 * sort keys map onto the backend's `sortBy` allow-list
 * (`tvl`, `volume24h`, `fees24h`, `feeTvlRatio24h`, `apr`, `binStep`,
 * `createdAt`) so a deep-linkable, server-paginated variant (the `/explore`
 * page) can reuse the exact same keys.
 *
 * Honesty: a null metric sorts to the BOTTOM (it is genuinely unknown, never
 * treated as zero), and the row still renders `--` for that field. Search
 * matches pair symbols, token names, and the pool / mint addresses.
 */

/** The sort keys exposed in the header, aligned with the `/clouds/pools`
 * `sortBy` allow-list. `feeTvlRatio24h` is derived client-side from the two
 * indexed fields the same way the backend computes it. */
export type PoolSortKey =
  | "tvl"
  | "volume24h"
  | "fees24h"
  | "feeTvlRatio24h"
  | "apr"
  | "binStep";

type SortDir = "asc" | "desc";

interface SortColumn {
  key: PoolSortKey;
  label: string;
}

/** Columns shown in the wide-layout header, in display order. */
const SORT_COLUMNS: readonly SortColumn[] = [
  { key: "tvl", label: "TVL" },
  { key: "volume24h", label: "24h volume" },
  { key: "fees24h", label: "24h fees" },
  { key: "apr", label: "APR" },
];

/**
 * Pull the numeric value a given sort key ranks on out of a pool row. Returns
 * `null` for an unindexed metric so the comparator can sink it to the bottom
 * regardless of direction (an unknown value must never outrank a real one).
 */
function sortValue(pool: PoolListItem, key: PoolSortKey): number | null {
  switch (key) {
    case "tvl":
      return pool.tvlUsd;
    case "volume24h":
      return pool.volume24hUsd;
    case "fees24h":
      return pool.fees24hUsd;
    case "apr":
      return pool.apr;
    case "binStep":
      return pool.binStep;
    case "feeTvlRatio24h": {
      if (pool.fees24hUsd === null || pool.tvlUsd === null || pool.tvlUsd <= 0) {
        return null;
      }
      return pool.fees24hUsd / pool.tvlUsd;
    }
    default:
      return null;
  }
}

/** Lowercased haystack of every searchable field on a pool row. */
function searchHaystack(pool: PoolListItem): string {
  return [
    pool.name,
    pool.address,
    pool.tokenX.symbol,
    pool.tokenX.name,
    pool.tokenX.address,
    pool.tokenY.symbol,
    pool.tokenY.name,
    pool.tokenY.address,
  ]
    .join(" ")
    .toLowerCase();
}

export interface PoolListProps {
  /** The pools to render (first page from `GET /clouds/pools`). */
  pools: PoolListItem[];
  /** Initial sort key (defaults to TVL). */
  initialSortKey?: PoolSortKey;
  /** Initial sort direction (defaults to descending). */
  initialSortDir?: SortDir;
  /** Whether to show the search box (defaults to true). */
  searchable?: boolean;
  /** Message shown when there are no pools at all (pre-filter). */
  emptyMessage?: string;
}

/**
 * The pool browser. Pure client component: it never fetches, it only sorts and
 * filters the `pools` it is handed.
 */
export function PoolList({
  pools,
  initialSortKey = "tvl",
  initialSortDir = "desc",
  searchable = true,
  emptyMessage = "No Ponk Clouds pools discovered yet. Rain the first one.",
}: PoolListProps) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<PoolSortKey>(initialSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialSortDir);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? pools.filter((p) => searchHaystack(p).includes(q))
      : pools.slice();

    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      // Unknown (null) metrics always sink to the bottom, both directions.
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va === vb) return 0;
      return va < vb ? -dir : dir;
    });
    return filtered;
  }, [pools, query, sortKey, sortDir]);

  const toggleSort = (key: PoolSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {searchable ? (
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pools by symbol, name, or address"
            inputMode="search"
            aria-label="Search pools"
            className="h-10 w-full rounded-md border border-line bg-elevated px-3 text-[13px] text-fg outline-none transition-colors placeholder:text-muted focus:border-pink/50"
          />
          <span className="hidden flex-none font-mono text-[12px] tabular-nums text-muted sm:inline">
            {visible.length} / {pools.length}
          </span>
        </div>
      ) : null}

      {/* sortable column header (wide layouts only; rows carry inline labels
          when stacked) */}
      {pools.length > 0 ? (
        <div className="hidden grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_auto] items-center gap-4 px-4 text-[11px] uppercase tracking-[0.04em] text-muted sm:grid">
          <span>Pool</span>
          {SORT_COLUMNS.map((col) => (
            <button
              key={col.key}
              type="button"
              onClick={() => toggleSort(col.key)}
              className="flex items-center justify-end gap-1 text-right uppercase tracking-[0.04em] transition-colors hover:text-fg"
              aria-label={`Sort by ${col.label}`}
            >
              {col.label}
              <SortCaret active={sortKey === col.key} dir={sortDir} />
            </button>
          ))}
          <span className="text-right" aria-hidden>
            &nbsp;
          </span>
        </div>
      ) : null}

      {pools.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : visible.length === 0 ? (
        <EmptyState message={`No pools match "${query.trim()}".`} />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((pool) => (
            <PoolCard key={pool.address} pool={pool} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A small up/down caret shown on the active sort column. Inactive columns
 * render a faint neutral glyph so the header keeps a stable width. */
function SortCaret({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <span className="text-muted/50" aria-hidden>
        &#8693;
      </span>
    );
  }
  return (
    <span className="text-pink" aria-hidden>
      {dir === "asc" ? "↑" : "↓"}
    </span>
  );
}

/** Honest empty state: a neutral panel, never a fabricated row. */
function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-card border border-dashed border-line bg-panel px-4 py-12 text-center text-[13px] text-muted">
      {message}
    </div>
  );
}
