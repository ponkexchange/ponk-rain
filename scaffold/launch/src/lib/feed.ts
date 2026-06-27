"use client";

/**
 * Live market-data feed client for Ponk Clouds, for `@ponkrain/launch`.
 *
 * A thin Server-Sent-Events wrapper around the backend's
 * `GET {API_URL}/clouds/feed?pool=&feeds=` endpoint (the same SSE stream the dex
 * consumes). The backend emits named SSE events:
 *
 *   - "ticker"   snapshot-on-connect: a DexScreener-shaped pair object
 *                  `{ feed, pool, ts, snapshot, data }`.
 *   - "price"    periodic price + last-trade tick
 *                  `{ feed, pool, ts, priceUsd, activeBinId, lastTrade }`.
 *   - "message"  a live indexer-published market event forwarded from the hub
 *                  (arbitrary JSON; exposed raw under `raw`).
 *   - "resync"   `{ op: "resync" }`: the client lagged the broadcast and should
 *                  refetch REST state to reconcile (surfaced as a tick).
 *   - keep-alive comments (handled transparently by `EventSource`).
 *
 * Ported from the dex `lib/cloudsFeed.ts`, with one difference: the backend base
 * URL is resolved here from `NEXT_PUBLIC_API_URL` (this scaffold's public env)
 * rather than the dex `@ponk/config` package, so the kit is self-contained. The
 * SSE stream is a browser-only, live connection that must reach the indexer
 * directly, so it uses the public base URL (not a same-origin `/api/*` proxy,
 * which the REST reads use).
 *
 * HONESTY: this layer never fabricates data. `priceUsd` / `lastTrade` / metrics
 * are forwarded exactly as the server sends them, including `null` (unknown) and
 * `0` (a real no-activity value). The hook normalises wire frames into typed
 * ticks and tracks connection status; the chart / trade pages consume the
 * latest tick. When no `NEXT_PUBLIC_API_URL` is configured there is no feed host
 * to open, so the hook stays idle and consumers fall back to their indexed /
 * on-chain values (rendered live-less, never faked).
 *
 * `EventSource` auto-reconnects on transport drops; the subscription is keyed on
 * `pool` / `feeds` / `enabled` so changing any of those tears down and reopens.
 */

import { useEffect, useRef, useState } from "react";

/**
 * The public backend base URL the live feed connects to, resolved from
 * `NEXT_PUBLIC_API_URL` (public, available in the browser bundle). Trailing
 * slashes are trimmed. `null` when unset, in which case the hook stays idle.
 */
const FEED_BASE: string | null = (() => {
  const base = process.env.NEXT_PUBLIC_API_URL;
  return base && base.trim() !== "" ? base.replace(/\/+$/, "") : null;
})();

/** Connection lifecycle for the feed. */
export type CloudsFeedStatus = "idle" | "connecting" | "open" | "closed";

/** A single trade as embedded in a `price` tick's `lastTrade`. */
export interface CloudsLastTrade {
  /** The swap transaction signature, base58. */
  signature: string;
  /** `buy` = quote -> base, `sell` = base -> quote (backend convention). */
  side: "buy" | "sell";
  /** Input amount, as a base-unit string. */
  amountIn: string;
  /** Output amount, as a base-unit string. */
  amountOut: string;
  /** USD notional, or `null` when the indexer could not price the swap. */
  volumeUsd: number | null;
  /** RFC3339 millis timestamp, or `null` when block time is unknown. */
  ts: string | null;
}

/** Periodic price tick (the `price` SSE event). */
export interface CloudsPriceTick {
  kind: "price";
  /** The pool PDA address this tick is for, base58. */
  pool: string;
  /** RFC3339 timestamp of the tick. */
  ts: string;
  /** Active price in USD, or `null` when the pool has no derivable price. */
  priceUsd: number | null;
  /** The pool's active bin id at the tick. */
  activeBinId: number;
  /** The most recent swap, or `null` when the pool has never traded. */
  lastTrade: CloudsLastTrade | null;
}

/**
 * Snapshot-on-connect ticker (the `ticker` SSE event). `data` is the
 * DexScreener pair object verbatim; left as `unknown` so consumers parse only
 * what they need without coupling this module to that shape.
 */
export interface CloudsTickerTick {
  kind: "ticker";
  /** The pool PDA address, base58. */
  pool: string;
  /** RFC3339 timestamp of the snapshot. */
  ts: string;
  /** Always `true` for the connect-time snapshot. */
  snapshot: boolean;
  /** The DexScreener-shaped pair object, verbatim. */
  data: unknown;
}

/** Live indexer-published market event forwarded from the hub (`message`). */
export interface CloudsMessageTick {
  kind: "message";
  /** The decoded payload if it was JSON, else `null`. */
  raw: unknown;
}

/** Lag signal: the client fell behind the broadcast and should refetch REST. */
export interface CloudsResyncTick {
  kind: "resync";
}

/** Any normalised tick the feed emits. */
export type CloudsFeedTick =
  | CloudsPriceTick
  | CloudsTickerTick
  | CloudsMessageTick
  | CloudsResyncTick;

/** The reactive state {@link useCloudsFeed} returns. */
export interface CloudsFeedState {
  /** The connection lifecycle status. */
  status: CloudsFeedStatus;
  /** The most recent tick of any kind, or `null` before the first frame. */
  last: CloudsFeedTick | null;
  /** The most recent `price` tick, convenient for chart/rate streaming. */
  lastPrice: CloudsPriceTick | null;
  /** The connect-time `ticker` snapshot, if one was received. */
  ticker: CloudsTickerTick | null;
}

/** Options for {@link useCloudsFeed}. */
export interface UseCloudsFeedOptions {
  /** The pool address to scope the feed to; price/trade ticks need this. */
  pool?: string;
  /** Feed names to request (forwarded as `?feeds=`); defaults to all. */
  feeds?: readonly string[];
  /** Set `false` to leave the connection closed (e.g. a hidden tab). */
  enabled?: boolean;
  /** Optional callback fired for every normalised tick. */
  onTick?: (tick: CloudsFeedTick) => void;
}

/** A finite number, or `null` for anything else (NaN, Infinity, non-number). */
function toNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalise a wire `lastTrade` object into a {@link CloudsLastTrade}. */
function parseLastTrade(v: unknown): CloudsLastTrade | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    signature: typeof o.signature === "string" ? o.signature : "",
    side: o.side === "sell" ? "sell" : "buy",
    amountIn: typeof o.amountIn === "string" ? o.amountIn : "",
    amountOut: typeof o.amountOut === "string" ? o.amountOut : "",
    volumeUsd: toNumberOrNull(o.volumeUsd),
    ts: typeof o.ts === "string" ? o.ts : null,
  };
}

/** Normalise a wire `price` frame into a {@link CloudsPriceTick}. */
function parsePriceTick(raw: unknown): CloudsPriceTick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    kind: "price",
    pool: typeof o.pool === "string" ? o.pool : "",
    ts: typeof o.ts === "string" ? o.ts : "",
    priceUsd: toNumberOrNull(o.priceUsd),
    activeBinId: typeof o.activeBinId === "number" ? o.activeBinId : 0,
    lastTrade: parseLastTrade(o.lastTrade),
  };
}

/** Normalise a wire `ticker` frame into a {@link CloudsTickerTick}. */
function parseTickerTick(raw: unknown): CloudsTickerTick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    kind: "ticker",
    pool: typeof o.pool === "string" ? o.pool : "",
    ts: typeof o.ts === "string" ? o.ts : "",
    snapshot: o.snapshot === true,
    data: o.data ?? null,
  };
}

/** Parse an SSE `data` payload as JSON, returning `null` on malformed input. */
function safeParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Build the `GET /clouds/feed` URL for a pool + feed list. */
function feedUrl(
  base: string,
  pool: string | undefined,
  feeds: readonly string[] | undefined,
): string {
  const search = new URLSearchParams();
  if (pool) search.set("pool", pool);
  if (feeds && feeds.length > 0) search.set("feeds", feeds.join(","));
  const qs = search.toString();
  return `${base}/clouds/feed${qs ? `?${qs}` : ""}`;
}

/**
 * Subscribe to the live Ponk Clouds market feed for a pool.
 *
 * Returns reactive connection status plus the latest tick(s). The connection is
 * keyed on `pool` / `feeds` / `enabled`, so changing any of those reopens the
 * stream. Safe to call with no `pool` (you still receive hub `message` /
 * `resync` ticks). When `NEXT_PUBLIC_API_URL` is unset there is no feed host, so
 * the hook stays `idle` and `lastPrice` stays `null`; consumers then render
 * their indexed / on-chain values without a live overlay (never a faked price).
 *
 * @param options - The pool, requested feeds, enabled flag, and tick callback.
 */
export function useCloudsFeed(
  options: UseCloudsFeedOptions = {},
): CloudsFeedState {
  const { pool, feeds, enabled = true, onTick } = options;

  const [status, setStatus] = useState<CloudsFeedStatus>("idle");
  const [last, setLast] = useState<CloudsFeedTick | null>(null);
  const [lastPrice, setLastPrice] = useState<CloudsPriceTick | null>(null);
  const [ticker, setTicker] = useState<CloudsTickerTick | null>(null);

  // Keep the callback in a ref so a changing `onTick` never re-opens the stream.
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const feedsKey = feeds ? feeds.join(",") : "";

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    // With no configured feed host, there is no stream to open. Stay idle so the
    // consumer falls back to its non-live values rather than a fabricated one.
    if (!FEED_BASE) {
      setStatus("idle");
      return;
    }
    // `EventSource` only exists in the browser.
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    const url = feedUrl(FEED_BASE, pool, feeds);
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      setStatus("closed");
      return;
    }
    setStatus("connecting");

    const emit = (tick: CloudsFeedTick) => {
      setLast(tick);
      if (tick.kind === "price") setLastPrice(tick);
      if (tick.kind === "ticker") setTicker(tick);
      onTickRef.current?.(tick);
    };

    es.onopen = () => setStatus("open");

    es.addEventListener("ticker", (e) => {
      const tick = parseTickerTick(safeParse((e as MessageEvent).data));
      if (tick) emit(tick);
    });

    es.addEventListener("price", (e) => {
      const tick = parsePriceTick(safeParse((e as MessageEvent).data));
      if (tick) emit(tick);
    });

    // Hub-forwarded market events arrive as the default "message" event.
    es.addEventListener("message", (e) => {
      emit({ kind: "message", raw: safeParse((e as MessageEvent).data) });
    });

    es.addEventListener("resync", () => {
      emit({ kind: "resync" });
    });

    // `EventSource` fires `onerror` on transport drops and the browser
    // auto-reconnects (status falls back to connecting). We do not close on
    // error so the built-in backoff keeps the live feed alive across blips.
    es.onerror = () => {
      setStatus(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
    };

    return () => {
      es.close();
      setStatus("closed");
    };
    // `feedsKey` captures `feeds` by value; eslint cannot see that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, feedsKey, enabled]);

  return { status, last, lastPrice, ticker };
}
