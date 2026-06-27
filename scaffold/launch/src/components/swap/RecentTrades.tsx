"use client";

/**
 * RecentTrades - the live swap tape for a single Ponk Clouds pool.
 *
 * Reads the most recent swaps for the pool from the backend keyset-paged swap
 * flow (`GET {API_URL}/clouds/swaps?pool=<address>&limit=<n>`) and renders them
 * newest-first: side (buy / sell), the in -> out amounts and symbols, the USD
 * notional when the indexer priced it, and a relative timestamp linking to the
 * transaction on Solscan. It refetches on a light interval so the tape stays
 * current without holding an SSE connection of its own (the trade page already
 * owns the live price feed; this is a low-frequency REST tape).
 *
 * HONESTY (the no-fabrication rule, end to end):
 *   - The base URL is the configured public `NEXT_PUBLIC_API_URL`. When none is
 *     set there is no swap source, so the tape renders an explicit "configure an
 *     API_URL" note rather than inventing trades.
 *   - A brand-new pool with no swaps returns an empty list, rendered as an
 *     explicit "no trades yet" empty state. We never synthesise a trade.
 *   - `volumeUsd` is shown only when the indexer priced the swap; an unpriced
 *     swap shows `--` for its USD column, never a guessed value.
 *   - A transport / non-OK response surfaces an honest error line.
 *
 * Symbols fall back to a short mint when the token is unindexed, matching the
 * rest of the app; nothing is labelled with a fabricated symbol.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/Card";
import { shortenAddress } from "@/lib/format";
import { solscanTxUrl } from "@/lib/config";

/**
 * The public backend base URL the tape reads from, resolved from
 * `NEXT_PUBLIC_API_URL`. Trailing slashes trimmed; `null` when unset (the tape
 * then renders an honest "no source" note instead of fabricating trades).
 */
const API_BASE: string | null = (() => {
  const base = process.env.NEXT_PUBLIC_API_URL;
  return base && base.trim() !== "" ? base.replace(/\/+$/, "") : null;
})();

/** How many recent swaps to show, and how often to refetch (ms). */
const TRADE_LIMIT = 30;
const REFRESH_MS = 15_000;

/** One leg of a swap as returned by `GET /clouds/swaps`. */
interface SwapLeg {
  /** The mint address, base58, or null when unknown. */
  address: string | null;
  /** The resolved symbol, or null when the token is unindexed. */
  symbol: string | null;
}

/** One swap row from `GET /clouds/swaps`, narrowed to what the tape renders. */
interface SwapRow {
  /** The swap transaction signature, base58. */
  signature: string;
  /** Whether the swap sold X for Y (drives the buy/sell label + colour). */
  xForY: boolean;
  /** The input leg (token paid). */
  tokenIn: SwapLeg;
  /** The output leg (token received). */
  tokenOut: SwapLeg;
  /** Input amount, base-unit string. */
  amountIn: string;
  /** Output amount, base-unit string. */
  amountOut: string;
  /** USD notional, or null when the indexer could not price the swap. */
  volumeUsd: number | null;
  /** RFC3339 block time, or null when unknown. */
  blockTime: string | null;
}

/** The load state of the tape. */
type TapeState = "loading" | "ready" | "empty" | "error" | "no-source";

/** A finite number, or null for anything else. */
function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Narrow one wire leg object into a {@link SwapLeg}. */
function parseLeg(v: unknown): SwapLeg {
  if (!v || typeof v !== "object") return { address: null, symbol: null };
  const o = v as Record<string, unknown>;
  return {
    address: typeof o.address === "string" ? o.address : null,
    symbol:
      typeof o.symbol === "string" && o.symbol.length > 0 ? o.symbol : null,
  };
}

/** Narrow one wire swap object into a {@link SwapRow}, or null when malformed. */
function parseSwap(v: unknown): SwapRow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.signature !== "string") return null;
  return {
    signature: o.signature,
    xForY: o.xForY === true,
    tokenIn: parseLeg(o.tokenIn),
    tokenOut: parseLeg(o.tokenOut),
    amountIn: typeof o.amountIn === "string" ? o.amountIn : "0",
    amountOut: typeof o.amountOut === "string" ? o.amountOut : "0",
    volumeUsd: numberOrNull(o.volumeUsd),
    blockTime: typeof o.blockTime === "string" ? o.blockTime : null,
  };
}

/** Pull the `swaps` array out of the `{ data: { swaps } }` / `{ swaps }` body. */
function parseSwaps(json: unknown): SwapRow[] {
  const root =
    json && typeof json === "object" && "data" in (json as Record<string, unknown>)
      ? (json as { data?: unknown }).data
      : json;
  const list =
    root && typeof root === "object"
      ? (root as { swaps?: unknown }).swaps
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: SwapRow[] = [];
  for (const row of list) {
    const swap = parseSwap(row);
    if (swap) out.push(swap);
  }
  return out;
}

/** A leg's display symbol, falling back to a short mint when unindexed. */
function legLabel(leg: SwapLeg): string {
  if (leg.symbol) return leg.symbol;
  if (leg.address) return shortenAddress(leg.address);
  return "--";
}

/** A human amount for a base-unit string. Returns `--` for an unparsable value. */
function amountLabel(raw: string): string {
  try {
    // The wire amounts are already in base units; without per-leg decimals from
    // this endpoint we render the integer base-unit amount grouped, which is the
    // exact on-chain value (never a decimals-guessed one).
    return BigInt(raw).toLocaleString("en-US");
  } catch {
    return "--";
  }
}

/** A USD label, or `--` when the swap was not priced. */
function usdLabel(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "--";
  if (Math.abs(v) < 0.01 && v !== 0) return "<$0.01";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** A compact relative time (e.g. `12s`, `3m`, `5h`, `2d`), or `--` when unknown. */
function relativeTime(iso: string | null): string {
  if (!iso) return "--";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "--";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Props for {@link RecentTrades}. */
export interface RecentTradesProps {
  /** The pool PDA address (base58) to read the swap tape for. */
  pool: string;
  /** Max trades to show (default {@link TRADE_LIMIT}). */
  limit?: number;
}

/**
 * The live swap tape for a Ponk Clouds pool. Fetches the real recent swaps from
 * the backend, refetches on a light interval, and renders honest loading /
 * empty / error / no-source states instead of ever fabricating a trade.
 *
 * @param pool - the pool PDA address to read swaps for.
 * @param limit - max trades to show.
 */
export function RecentTrades({ pool, limit = TRADE_LIMIT }: RecentTradesProps) {
  const [rows, setRows] = useState<SwapRow[]>([]);
  const [state, setState] = useState<TapeState>(
    API_BASE ? "loading" : "no-source",
  );

  // Guards against a slow response overwriting a newer one and against setting
  // state after unmount.
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!API_BASE || !pool) return;
    const id = ++reqIdRef.current;
    try {
      const search = new URLSearchParams({
        pool,
        limit: String(limit),
      });
      const res = await fetch(`${API_BASE}/clouds/swaps?${search.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      if (id !== reqIdRef.current) return;
      const swaps = parseSwaps(json);
      setRows(swaps);
      setState(swaps.length === 0 ? "empty" : "ready");
    } catch {
      if (id !== reqIdRef.current) return;
      // Only fall to the error state on the first load; on a refresh failure we
      // keep the last good rows so a transient blip does not blank the tape.
      setState((prev) => (prev === "ready" ? "ready" : "error"));
    }
  }, [pool, limit]);

  useEffect(() => {
    if (!API_BASE) {
      setState("no-source");
      return;
    }
    setState("loading");
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      // Invalidate any in-flight request from this pool when it changes/unmounts.
      reqIdRef.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-fg">Recent trades</h2>
        {state === "ready" ? (
          <span className="text-[10px] uppercase tracking-wide text-muted">
            live
          </span>
        ) : null}
      </div>

      {state === "loading" ? (
        <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line border-t-pink" />
          loading trades
        </div>
      ) : state === "error" ? (
        <p className="m-0 px-4 py-6 text-[12px] text-negative">
          trade feed unavailable
        </p>
      ) : state === "no-source" ? (
        <p className="m-0 px-4 py-6 text-[12px] leading-relaxed text-muted">
          Set NEXT_PUBLIC_API_URL to a Ponk indexer to show the live swap tape.
          Nothing is shown until a real source is configured.
        </p>
      ) : state === "empty" ? (
        <p className="m-0 px-4 py-6 text-[12px] leading-relaxed text-muted">
          No trades yet. This tape fills in from real swaps; we never backfill or
          invent trades.
        </p>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-2 py-2 font-medium">Amount</th>
                <th className="px-2 py-2 text-right font-medium">USD</th>
                <th className="px-4 py-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // x_for_y sells the base (X) for the quote (Y): a "sell". The
                // opposite direction buys the base: a "buy".
                const isBuy = !row.xForY;
                return (
                  <tr
                    key={row.signature}
                    className="border-t border-line/60 hover:bg-elevated/60"
                  >
                    <td className="px-4 py-2">
                      <span
                        className={
                          "font-medium " +
                          (isBuy ? "text-positive" : "text-negative")
                        }
                      >
                        {isBuy ? "Buy" : "Sell"}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="font-mono tabular-nums text-fg">
                        {amountLabel(row.amountIn)}{" "}
                        <span className="text-muted">
                          {legLabel(row.tokenIn)}
                        </span>
                      </span>
                      <span className="px-1 text-muted">-&gt;</span>
                      <span className="font-mono tabular-nums text-fg">
                        {amountLabel(row.amountOut)}{" "}
                        <span className="text-muted">
                          {legLabel(row.tokenOut)}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-fg">
                      {usdLabel(row.volumeUsd)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <a
                        href={solscanTxUrl(row.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono tabular-nums text-muted hover:text-pink hover:underline"
                        title={row.blockTime ?? row.signature}
                      >
                        {relativeTime(row.blockTime)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
