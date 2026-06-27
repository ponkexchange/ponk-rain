"use client";

/**
 * Analytics - the pool analytics panel for a Ponk Clouds DLMM.
 *
 * A null-aware KPI grid driven by the backend pool-detail response
 * (`GET /clouds/pool/:address`, surfaced same-origin via `/api/pool/:address`)
 * and, when present, the extended 24h metrics block the same endpoint returns
 * under `?withMetrics`. It renders price, 24h volume, 24h fees, TVL, APR, swaps,
 * traders, LPs, open positions, fee rate, net 24h deposits, and holders.
 *
 * HONESTY (the leaf-level no-fabrication rule):
 *   - Every money / count field renders "--" when the indexer value is null.
 *     A real 0 (e.g. a pool that genuinely had zero swaps today) is shown as 0,
 *     never blanked. We distinguish null (unknown) from 0 (real) explicitly.
 *   - The Ponk Clouds indexer does NOT compute a per-pool holder count, so
 *     `holders` is shown as "--" unless the caller supplies one. We never
 *     estimate it from LP count or anything else.
 *   - The displayed live price prefers the streamed feed tick (`livePrice`) over
 *     the pool's on-chain `currentPrice`, but neither is invented: if both are
 *     null the price reads "--".
 *
 * This is a pure presentational component. The page fetches the data (server
 * component or query) and the trade panel wires the live tick in; here we only
 * format and lay it out, so it is reusable on /pool/[address] and /trade/[pool].
 */

import { useMemo } from "react";

/**
 * The pool-detail shape this panel consumes, mirroring the backend
 * `GET /clouds/pool/:address` JSON. Only the fields the panel reads are typed;
 * unknown extra fields are ignored. Every metric is nullable: the indexer
 * returns `null` for any value it cannot yet derive (a brand-new pool, an
 * un-priceable quote), and we honor that null end-to-end.
 */
export interface AnalyticsPool {
  /** Pool address (base58). */
  address: string;
  /** Base token metadata. */
  tokenX?: { symbol?: string | null; decimals?: number | null } | null;
  /** Quote token metadata. */
  tokenY?: { symbol?: string | null; decimals?: number | null } | null;
  /** Active-bin price (quote per base) from chain state, or null. */
  currentPrice?: number | null;
  /** Bin step in bps. */
  binStep?: number | null;
  /** Base swap fee as a percent (e.g. 0.04 = 4 bps), or null. */
  baseFeePct?: number | null;
  /** Creator protocol-fee cut as a percent of the swap fee, or null. */
  protocolFeePct?: number | null;
  /** Total value locked in USD, or null when un-priceable. */
  tvlUsd?: number | null;
  /** Trailing-24h swap volume in USD, or null. */
  volume24hUsd?: number | null;
  /** Trailing-24h LP fees in USD, or null. */
  fees24hUsd?: number | null;
  /** Trailing-24h fee APR as a percent, or null. */
  apr?: number | null;
}

/**
 * The extended 24h metrics block (the backend's `?withMetrics` extra, also
 * available via `GET /clouds/pool/:address` extended fields). All nullable.
 */
export interface AnalyticsMetrics {
  /** Distinct swaps in the trailing 24h. */
  swaps24h?: number | null;
  /** Distinct swap signers in the trailing 24h. */
  traders24h?: number | null;
  /** Distinct LP owners across all open positions (all-time). */
  totalLps?: number | null;
  /** Count of open (rent-funded) position accounts. */
  openPositions?: number | null;
  /** Average fee rate over the window, USD per minute. */
  feesPerMinUsd?: number | null;
  /** Net (adds - withdrawals) liquidity flow in USD over 24h (can be negative). */
  netDeposits24hUsd?: number | null;
}

export interface AnalyticsProps {
  /** The pool-detail object. `null` while the parent query is unresolved. */
  pool: AnalyticsPool | null;
  /** Extended 24h metrics, if the parent fetched them. Optional. */
  metrics?: AnalyticsMetrics | null;
  /**
   * Latest streamed price in USD from `useCloudsFeed().lastPrice.priceUsd`,
   * injected by the parent. Takes precedence over the on-chain `currentPrice`
   * for the headline price. `null` = no live price; never coerced.
   */
  livePrice?: number | null;
  /**
   * Per-pool holder count, IF the caller has a real source for it. The Ponk
   * Clouds indexer does not expose one, so this is normally omitted and the
   * holders stat renders "--". Never estimate this value.
   */
  holders?: number | null;
  /** When true, render skeleton placeholders instead of values. */
  loading?: boolean;
}

/** Join class names, dropping falsy entries. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** True for a real, finite number (0 included). null/undefined/NaN are not. */
function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** USD with K/M/B compaction; "--" for null/undefined/non-finite. */
function fmtUsd(v: number | null | undefined): string {
  if (!isNum(v)) return "--";
  const neg = v < 0;
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1e9) body = `${(abs / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) body = `${(abs / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) body = `${(abs / 1e3).toFixed(2)}K`;
  else body = abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}$${body}`;
}

/** Plain USD price (no compaction): full precision under $1. "--" for null. */
function fmtPriceUsd(v: number | null | undefined): string {
  if (!isNum(v)) return "--";
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (v >= 0.001) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  return `$${v.toExponential(2)}`;
}

/** Integer count with thousands grouping; "--" for null/undefined. */
function fmtCount(v: number | null | undefined): string {
  if (!isNum(v)) return "--";
  return Math.round(v).toLocaleString("en-US");
}

/** Percent with two decimals; "--" for null/undefined. */
function fmtPct(v: number | null | undefined): string {
  if (!isNum(v)) return "--";
  return `${v.toFixed(2)}%`;
}

/** Fee rate in USD per minute -> "$x/min"; "--" for null. */
function fmtPerMin(v: number | null | undefined): string {
  if (!isNum(v)) return `--`;
  return `${fmtUsd(v)}/min`;
}

/**
 * One labelled stat cell. Renders the formatted value, "--" honored by the
 * formatter for null. An optional `hint` is shown as a small note under the
 * value (e.g. why holders is "--"), and `tone` colors PnL-style deltas.
 */
function StatCell({
  label,
  value,
  hint,
  tone = "default",
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "positive" | "negative";
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-elevated px-3 py-2.5">
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted">{label}</span>
      {loading ? (
        <span className="h-4 w-16 animate-shimmer rounded bg-gradient-to-r from-line/40 via-line to-line/40 bg-[length:200%_100%]" />
      ) : (
        <span
          className={cx(
            "font-mono text-[15px] font-semibold leading-none tabular-nums",
            tone === "positive" && "text-positive",
            tone === "negative" && "text-negative",
            tone === "default" && "text-fg",
          )}
        >
          {value}
        </span>
      )}
      {hint && !loading ? (
        <span className="text-[10px] leading-tight text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/**
 * Pool analytics panel. Lays out the headline price plus a responsive grid of
 * KPI cells, all null-aware. Holders renders "--" with an honest note when no
 * real source is supplied, since the indexer does not compute it.
 */
export function Analytics({
  pool,
  metrics = null,
  livePrice = null,
  holders = null,
  loading = false,
}: AnalyticsProps) {
  const baseSym = pool?.tokenX?.symbol || "TOKEN";
  const quoteSym = pool?.tokenY?.symbol || "USDC";

  // Headline price: live tick first (if real), else on-chain active price.
  const headPrice = useMemo<number | null>(() => {
    if (isNum(livePrice) && livePrice > 0) return livePrice;
    if (isNum(pool?.currentPrice)) return pool!.currentPrice as number;
    return null;
  }, [livePrice, pool]);

  // Net deposits is the only signed metric: color it by direction.
  const netDeposits = metrics?.netDeposits24hUsd;
  const netTone: "default" | "positive" | "negative" = !isNum(netDeposits)
    ? "default"
    : netDeposits >= 0
      ? "positive"
      : "negative";

  const isLoading = loading || pool === null;

  return (
    <section className="flex flex-col gap-4 rounded-card border border-line bg-panel p-4">
      {/* header: pair + live price */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="m-0 text-[13px] font-semibold tracking-[-0.01em] text-fg">
            Analytics
          </h3>
          <span className="text-[10px] uppercase tracking-[0.08em] text-muted">
            {baseSym}/{quoteSym}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[20px] font-semibold leading-none tabular-nums text-fg">
            {isLoading ? "--" : fmtPriceUsd(headPrice)}
          </span>
          {isNum(livePrice) && livePrice > 0 ? (
            <span className="rounded-full border border-pink/40 bg-pink/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-pink">
              live
            </span>
          ) : null}
        </div>
      </div>

      {/* primary 24h metrics */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCell label="24h Volume" value={fmtUsd(pool?.volume24hUsd)} loading={isLoading} />
        <StatCell label="24h Fees" value={fmtUsd(pool?.fees24hUsd)} loading={isLoading} />
        <StatCell label="TVL" value={fmtUsd(pool?.tvlUsd)} loading={isLoading} />
        <StatCell label="Fee APR" value={fmtPct(pool?.apr)} loading={isLoading} />
        <StatCell label="24h Swaps" value={fmtCount(metrics?.swaps24h)} loading={isLoading} />
        <StatCell
          label="Holders"
          value={fmtCount(holders)}
          hint={isNum(holders) ? undefined : "not indexed on-chain"}
          loading={isLoading}
        />
      </div>

      {/* secondary metrics (the extended block); rendered only when wired so we
          do not show a wall of "--" on the trade page where metrics are omitted */}
      {metrics ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCell label="24h Traders" value={fmtCount(metrics.traders24h)} loading={isLoading} />
          <StatCell label="Total LPs" value={fmtCount(metrics.totalLps)} loading={isLoading} />
          <StatCell label="Open Positions" value={fmtCount(metrics.openPositions)} loading={isLoading} />
          <StatCell label="Fee Rate" value={fmtPerMin(metrics.feesPerMinUsd)} loading={isLoading} />
          <StatCell
            label="Net 24h Deposits"
            value={fmtUsd(netDeposits)}
            tone={netTone}
            loading={isLoading}
          />
          <StatCell
            label="Bin Step"
            value={isNum(pool?.binStep) ? `${pool!.binStep} bps` : "--"}
            loading={isLoading}
          />
        </div>
      ) : null}

      {/* fee structure footnote: honest reminder that the AMM protocol fee is
          zero; the only cut is the creator's slice of the swap fee */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[11px] text-muted">
        <span>
          Base fee{" "}
          <span className="font-mono text-fg">
            {isNum(pool?.baseFeePct) ? `${(pool!.baseFeePct as number).toFixed(2)}%` : "--"}
          </span>
        </span>
        <span>
          Creator fee{" "}
          <span className="font-mono text-fg">
            {isNum(pool?.protocolFeePct) ? `${(pool!.protocolFeePct as number).toFixed(2)}%` : "--"}
          </span>{" "}
          of swap fee
        </span>
        <span className="text-pink">Zero protocol fee at the AMM level</span>
      </div>
    </section>
  );
}
