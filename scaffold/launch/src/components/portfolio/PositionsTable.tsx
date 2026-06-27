"use client";

/**
 * PositionsTable: the LP positions table for /portfolio and the owner-position
 * section of /pool/[address].
 *
 * It consumes a flat list of {@link CloudsPositionRow} (the merged result of the
 * indexer-backed `/clouds/positions` API and the on-chain fallback read), and
 * renders one row per open position with: the token pair, bin step + swap fee,
 * net PnL ($ and %), the position's current value, its 24h fee/TVL, the pool
 * price, and an in-range badge. Each row links to the pool's add/remove
 * liquidity panels (`/pool/[address]?action=add`).
 *
 * HONESTY (do not paper over): every USD / percent / price figure the source
 * could not value renders a plain "--", never a fabricated number. A genuine
 * zero renders "$0.00" / "0%". `claimableUsd` is ALWAYS 0 for Ponk Clouds
 * because swap fees auto-compound into the bin reserves; there is no separate
 * claimable balance, so this table never shows a claim affordance. Rows read
 * straight from chain (no indexer row yet) honestly report value/PnL as null.
 *
 * The component owns no transaction logic and no data fetching: it is a pure
 * presentational table over the rows the page hands it, so it can be reused by
 * both the portfolio page (all of an owner's positions) and a pool page (the
 * owner's positions in that one pool, via the `poolAddress` filter the caller
 * applies before passing rows in).
 */

import Link from "next/link";
import { useMemo, useState } from "react";

/**
 * One LP position row.
 *
 * Mirrors the backend `/clouds/positions` shape and the on-chain fallback
 * (`readOnchainCloudsPositions`-style) shape exactly, so the page can merge API
 * rows and chain rows into a single `CloudsPositionRow[]` and hand them here
 * without translation. USD / PnL / fee-ratio fields are `number | null` so an
 * unpriced position renders an honest "--".
 */
export interface CloudsPositionRow {
  /** Position PDA address, base58. */
  positionAddress: string;
  /** The pool the position belongs to, base58. */
  poolAddress: string;
  /** Base-token (X) mint, base58. */
  tokenX: string;
  /** Quote-token (Y) mint, base58. */
  tokenY: string;
  /** Display symbol for the base token, or null to fall back to a short mint. */
  symbolX?: string | null;
  /** Display symbol for the quote token, or null to fall back to a short mint. */
  symbolY?: string | null;
  /** Bin step in basis points. */
  binStep: number;
  /** Swap fee as a percent of the trade (e.g. 0.04 for 4 bps). */
  feePct: number;
  /** Current position value in USD, or null when not USD-priceable. */
  valueUsd: number | null;
  /** All-time deposit (cost basis) in USD, or null when unknown. */
  depositUsd: number | null;
  /** Net PnL in USD, or null when value or basis is unknown. */
  pnlUsd: number | null;
  /** Net PnL as a percent of the deposit, or null when unknown. */
  pnlPct: number | null;
  /** Always 0 for Ponk Clouds (fees auto-compound); never a fabricated balance. */
  claimableUsd: number;
  /** Trailing-24h fee / TVL as a percent, or null when not indexed. */
  feeTvl24hPct: number | null;
  /** Pool price (quote per base) from the active bin, or null when unknown. */
  poolPrice: number | null;
  /** Whether the pool's active bin lies within the position's range. */
  inRange: boolean;
  /** `/clouds/positions` only returns open positions, so this is always true. */
  isOpen: boolean;
  /** ISO timestamp of the read, for "as of" display. */
  updatedAt: string;
}

/** Rows per page before client-side pagination kicks in. */
const PAGE_SIZE = 10;

/** USD with magnitude suffixes; honest "--" on null/undefined/non-finite. */
function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Signed percent with explicit leading +; honest "--" on null/non-finite. */
function fmtSignedPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** Plain percent (no leading +), e.g. fee/TVL or swap fee; "--" on null. */
function fmtPlainPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  return `${v.toFixed(2)}%`;
}

/** Pool price (a quote-per-base ratio, no $): adaptive precision; "--" null. */
function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v === 0) return "0";
  return v.toPrecision(4);
}

/** Tone class for a signed value: positive pink-up, negative down, else fg. */
function toneForSigned(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) {
    return "text-fg";
  }
  return v > 0 ? "text-positive" : "text-negative";
}

/** Short mint label `Xxxx..Xxxx`; honest fallback when no symbol is known. */
function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}..${mint.slice(-4)}` : mint;
}

/** Resolve a display symbol for a side: provided symbol, else short mint. */
function symbolFor(symbol: string | null | undefined, mint: string): string {
  return symbol && symbol.length > 0 ? symbol : shortMint(mint);
}

/** A small monogram chip for a token side (no logo dependency, never broken). */
function Mono({ label }: { label: string }) {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-elevated text-[9px] font-semibold uppercase text-muted">
      {label.slice(0, 2)}
    </span>
  );
}

/** The pair cell: two overlapping monograms + "X / Y" symbols. */
function PairCell({ row }: { row: CloudsPositionRow }) {
  const sx = symbolFor(row.symbolX, row.tokenX);
  const sy = symbolFor(row.symbolY, row.tokenY);
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center">
        <Mono label={sx} />
        <span className="-ml-1.5">
          <Mono label={sy} />
        </span>
      </span>
      <span className="font-medium text-fg">
        {sx} / {sy}
      </span>
    </div>
  );
}

/** In-range / out-of-range badge. Honest: derived from the on-chain flag. */
function RangeBadge({ inRange }: { inRange: boolean }) {
  return (
    <span
      className={
        inRange
          ? "rounded-full border border-positive/40 bg-positive/10 px-2 py-0.5 text-[10px] font-medium text-positive"
          : "rounded-full border border-line bg-elevated px-2 py-0.5 text-[10px] font-medium text-muted"
      }
    >
      {inRange ? "In range" : "Out of range"}
    </span>
  );
}

/**
 * Render the positions table.
 *
 * @param rows - the positions to show (already merged + filtered by the caller).
 * @param emptyLabel - the message shown when `rows` is empty (e.g. the pool page
 *   says "No liquidity in this pool yet"; the portfolio says "No open positions").
 * @param showActions - when false, the trailing Manage link column is hidden
 *   (used in compact contexts); defaults to true.
 */
export function PositionsTable({
  rows,
  emptyLabel = "No open positions.",
  showActions = true,
}: {
  rows: CloudsPositionRow[];
  emptyLabel?: string;
  showActions?: boolean;
}) {
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Clamp the page if the row count shrank (e.g. a refetch dropped a closed one).
  const safePage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [rows, safePage],
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-card border border-line bg-panel px-6 py-12 text-center">
        <p className="m-0 text-sm font-medium text-fg">{emptyLabel}</p>
        <p className="m-0 text-[12px] text-muted">
          Open one from a pool&apos;s liquidity panel to see it here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.06em] text-muted">
              <th className="px-4 py-3 font-medium">Pair</th>
              <th className="px-4 py-3 font-medium">Bin / Fee</th>
              <th className="px-4 py-3 text-right font-medium">PnL</th>
              <th className="px-4 py-3 text-right font-medium">Value</th>
              <th className="px-4 py-3 text-right font-medium">Deposit</th>
              <th className="px-4 py-3 text-right font-medium">24h Fee/TVL</th>
              <th className="px-4 py-3 text-right font-medium">Pool price</th>
              <th className="px-4 py-3 text-center font-medium">Range</th>
              {showActions ? (
                <th className="px-4 py-3 text-right font-medium">Manage</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.positionAddress}
                className="border-b border-line/60 last:border-b-0 hover:bg-elevated/40"
              >
                <td className="px-4 py-3">
                  <PairCell row={row} />
                </td>
                <td className="px-4 py-3 text-muted">
                  <span className="font-mono text-[12px] text-fg">
                    {row.binStep}
                  </span>
                  <span className="mx-1 text-line">/</span>
                  <span className="font-mono text-[12px]">
                    {fmtPlainPct(row.feePct)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className={`font-mono ${toneForSigned(row.pnlUsd)}`}>
                    {fmtUsd(row.pnlUsd)}
                  </div>
                  <div
                    className={`text-[11px] font-mono ${toneForSigned(row.pnlPct)}`}
                  >
                    {fmtSignedPct(row.pnlPct)}
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono text-fg">
                  {fmtUsd(row.valueUsd)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-muted">
                  {fmtUsd(row.depositUsd)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-muted">
                  {fmtPlainPct(row.feeTvl24hPct)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-muted">
                  {fmtPrice(row.poolPrice)}
                </td>
                <td className="px-4 py-3 text-center">
                  <RangeBadge inRange={row.inRange} />
                </td>
                {showActions ? (
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/pool/${row.poolAddress}?action=add`}
                      className="rounded-card border border-line px-3 py-1.5 text-[12px] font-medium text-fg hover:border-pink/50 hover:text-pink"
                    >
                      Manage
                    </Link>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-end gap-2 text-[12px] text-muted">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="rounded-card border border-line px-2.5 py-1 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="font-mono">
            {safePage + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            className="rounded-card border border-line px-2.5 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
