/**
 * One Ponk Clouds pool, rendered as a row in the {@link PoolList} table (and as
 * a stacked card on narrow viewports).
 *
 * Every money field is honest: when the indexer has not yet computed a metric
 * the backend sends `null`, which surfaces here as the shared `--` dash via
 * {@link formatUsd} / {@link formatPct}. Nothing is fabricated. The pair name,
 * bin step and base fee come straight off the on-chain pool record (always
 * present), so those never dash.
 *
 * The card is a single anchor to the pool's trade view (`/trade/[pool]`); a
 * secondary link drops into the pool detail / liquidity page
 * (`/pool/[address]`). The `zero-protocol-fee` tag the backend stamps on every
 * Ponk Clouds pool is rendered as a small badge, since the AMM itself never
 * skims the trade.
 */

import Link from "next/link";

import { TokenIcon } from "@/components/pools/TokenIcon";
import { formatUsd, formatPct } from "@/lib/format";

/**
 * The token leg shape inside a pool list row, as served by
 * `GET /clouds/pools` (`tokenX` / `tokenY`). `symbol` / `name` may be empty
 * strings when the token is not in the registry; `logoUri` is optional.
 */
export interface PoolToken {
  /** Mint address, base58. */
  address: string;
  /** Token symbol, or `""` when unknown (falls back to a short-mint label). */
  symbol: string;
  /** Token name, or `""` when unknown. */
  name: string;
  /** Token decimals. */
  decimals: number;
  /** Logo URI, or null/undefined when none is known. */
  logoUri?: string | null;
  /** Whether the token is registry-verified. */
  verified?: boolean;
}

/**
 * A single pool row as served by `GET /clouds/pools`. Money metrics are
 * `number | null` (null = not yet indexed, rendered as `--`); identity fields
 * (address, pair, bin step, fees) are always present from the on-chain record.
 */
export interface PoolListItem {
  /** Pool PDA address, base58. */
  address: string;
  /** Display pair name, e.g. `"SOL/USDC"`. */
  name: string;
  /** Base-token leg (X side). */
  tokenX: PoolToken;
  /** Quote-token leg (Y side). */
  tokenY: PoolToken;
  /** Bin step in basis points. */
  binStep: number;
  /** Base (swap) fee as a percent, e.g. `0.04` for 4 bps. */
  baseFeePct: number;
  /** Creator protocol fee as a percent OF the swap fee. */
  protocolFeePct: number;
  /** Current pool price (quote per base), or null when unpriced. */
  currentPrice: number | null;
  /** Total value locked in USD, or null when not yet indexed. */
  tvlUsd: number | null;
  /** Trailing-24h swap volume in USD, or null when not yet indexed. */
  volume24hUsd: number | null;
  /** Trailing-24h fees in USD, or null when not yet indexed. */
  fees24hUsd: number | null;
  /** Annualized 24h fee APR as a percent, or null when not yet indexed. */
  apr: number | null;
  /** Tags stamped by the backend (always includes `"zero-protocol-fee"`). */
  tags: string[];
}

/** Resolve a leg's display symbol with an honest short-mint fallback. */
function legSymbol(token: PoolToken): string {
  if (token.symbol && token.symbol.trim() !== "") return token.symbol;
  const m = token.address;
  return m.length > 8 ? `${m.slice(0, 4)}..${m.slice(-4)}` : m;
}

/**
 * Render one pool as a card/row. `baseFeePct`, `protocolFeePct` and `apr` are
 * already expressed as percents by the backend, so they pass straight to
 * {@link formatPct}; USD figures pass to {@link formatUsd}, which renders the
 * shared `--` dash for a null (unindexed) value.
 */
export function PoolCard({ pool }: { pool: PoolListItem }) {
  const symX = legSymbol(pool.tokenX);
  const symY = legSymbol(pool.tokenY);
  const zeroFee = pool.tags?.includes("zero-protocol-fee");

  return (
    <div className="group relative grid grid-cols-1 gap-3 rounded-card border border-line bg-panel p-4 transition-colors hover:border-pink/40 sm:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_auto] sm:items-center sm:gap-4">
      {/* pair + icons */}
      <Link
        href={`/trade/${pool.address}`}
        className="flex min-w-0 items-center gap-3 no-underline"
      >
        <span className="flex flex-none items-center -space-x-2">
          <TokenIcon
            mint={pool.tokenX.address}
            symbol={symX}
            logoUri={pool.tokenX.logoUri ?? null}
            size={28}
          />
          <TokenIcon
            mint={pool.tokenY.address}
            symbol={symY}
            logoUri={pool.tokenY.logoUri ?? null}
            size={28}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-semibold text-fg">
            {symX} / {symY}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="font-mono tabular-nums">{pool.binStep} bps</span>
            <span aria-hidden>&middot;</span>
            <span className="font-mono tabular-nums">
              {formatPct(pool.baseFeePct)} fee
            </span>
            {zeroFee ? (
              <span className="ml-0.5 rounded-full border border-pink/40 bg-pink/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.06em] text-pink">
                zero protocol fee
              </span>
            ) : null}
          </span>
        </span>
      </Link>

      {/* metrics: honest -- when null */}
      <Metric label="TVL" value={formatUsd(pool.tvlUsd)} />
      <Metric label="24h volume" value={formatUsd(pool.volume24hUsd)} />
      <Metric label="24h fees" value={formatUsd(pool.fees24hUsd)} />
      <Metric
        label="APR"
        value={pool.apr === null ? null : formatPct(pool.apr)}
      />

      {/* actions */}
      <span className="flex flex-none items-center gap-2 sm:justify-end">
        <Link
          href={`/trade/${pool.address}`}
          className="rounded-md border border-line bg-elevated px-3 py-1.5 text-[12px] font-medium text-fg no-underline transition-colors hover:border-pink/40 hover:text-pink"
        >
          Trade
        </Link>
        <Link
          href={`/pool/${pool.address}`}
          className="rounded-md border border-line bg-elevated px-3 py-1.5 text-[12px] font-medium text-muted no-underline transition-colors hover:border-pink/40 hover:text-fg"
        >
          Liquidity
        </Link>
      </span>
    </div>
  );
}

/**
 * One labelled metric cell. On wide layouts the label is visually hidden (the
 * column header carries it); on stacked/narrow layouts it prefixes the value so
 * the number is never ambiguous. `value` is already formatted (or `null` ->
 * the shared `--` dash) by the caller.
 */
function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <span className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-end sm:justify-center">
      <span className="text-[11px] uppercase tracking-[0.04em] text-muted sm:hidden">
        {label}
      </span>
      <span className="font-mono text-[13px] tabular-nums text-fg">
        {value ?? "--"}
      </span>
    </span>
  );
}
