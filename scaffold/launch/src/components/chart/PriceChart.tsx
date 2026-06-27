"use client";

/**
 * PriceChart - candlestick / area price chart for a single Ponk Clouds pool.
 *
 * Built on Lightweight Charts (TradingView's open engine, v4) and fed by the
 * same-origin `/api/stats?resource=volume&pool=...` proxy, which forwards to the
 * backend `GET /clouds/volume` OHLCV endpoint (the configured market-reference
 * series for the pool's base asset). The wire shape is the canonical Ponk
 * `{ data: { ohlcv: number[][] } }` envelope where each row is
 * `[unixSeconds, open, high, low, close, volume]`, newest-last.
 *
 * Live overlay: the parent (TradePanel) opens the SSE feed with `useCloudsFeed`
 * and passes the latest `lastPrice.priceUsd` down as the `livePrice` prop. We
 * draw it as a dashed price line and as the headline last price so the rate
 * tracks the stream between candle closes. The prop is injected rather than the
 * hook being imported here so this chart stays a pure, reusable presentational
 * component (no hard coupling to the feed module) - the only live input is a
 * number-or-null.
 *
 * HONESTY: a brand-new pool with no trades returns an empty OHLCV list. We never
 * synthesise candles, flat lines, or a fake price. In that case we render an
 * explicit "no trades yet" state (optionally pinned to the pool's on-chain
 * active price if the parent supplies one via `activePrice`, clearly labelled as
 * the AMM price, not a trade). Any null/0 from the feed is forwarded exactly.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";

// lightweight-charts paints to <canvas> and cannot read CSS custom properties,
// so these mirror the design tokens (--positive / --negative / --pink) as
// literal colors. Keep in sync with src/app/globals.css.
const UP = "#34d399"; // --positive
const DOWN = "#f87171"; // --negative
const UP_VOL = "rgba(52,211,153,0.32)";
const DOWN_VOL = "rgba(248,113,113,0.32)";
const PINK = "#ec4899"; // --pink

/** A normalised candle in chart space. */
interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Render type toggle. "Candles" is the default; "Area" is a clean close line. */
const TYPES = ["Candles", "Area"] as const;
type ChartType = (typeof TYPES)[number];

/**
 * Supported resolutions. Each (tf, agg) pair MUST be one the backend
 * `/clouds/volume` OHLCV endpoint can serve, so we never request a resolution
 * that comes back empty for a pool that does have history.
 */
const TFS = [
  { key: "5m", tf: "minute", agg: 5 },
  { key: "15m", tf: "minute", agg: 15 },
  { key: "1H", tf: "hour", agg: 1 },
  { key: "4H", tf: "hour", agg: 4 },
  { key: "1D", tf: "day", agg: 1 },
] as const;
type TfKey = (typeof TFS)[number]["key"];

type LoadState = "loading" | "ready" | "empty" | "error";

export interface PriceChartProps {
  /** Pool address (base58). Required to scope the OHLCV request. */
  pool: string;
  /** Base token symbol for the header label (e.g. "PONK"). */
  symbol?: string;
  /** Quote token symbol for the header label. Defaults to "USDC". */
  quoteSymbol?: string;
  /**
   * Latest streamed price in USD from `useCloudsFeed().lastPrice.priceUsd`,
   * injected by the parent. `null` = unknown / no live price; forwarded exactly,
   * never coerced to a number.
   */
  livePrice?: number | null;
  /**
   * The pool's on-chain active-bin price (quote per base), if the parent has it.
   * Used ONLY to anchor the empty state of a pool that has never traded; it is
   * an AMM quote, not a trade, and is labelled as such. Optional.
   */
  activePrice?: number | null;
  /** Fixed chart height in px. Defaults to 460. */
  height?: number;
}

/** Compact price formatter: full precision under $1, grouped above. */
function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 0.001) return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return v.toExponential(2);
}

/** Compact volume formatter (K/M/B). */
function fmtVol(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/** Join class names, dropping falsy entries. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Coerce one wire OHLCV row into a Candle, or null when it is malformed. We
 * never invent missing fields: a row that is not a 6-number tuple with finite,
 * positive prices is dropped, not patched.
 */
function rowToCandle(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [t, o, h, l, c, v] = row as unknown[];
  const nums = [t, o, h, l, c, v];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
  }
  const time = t as number;
  const open = o as number;
  const high = h as number;
  const low = l as number;
  const close = c as number;
  const volume = v as number;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  return {
    time: Math.floor(time) as UTCTimestamp,
    open,
    high,
    low,
    close,
    volume: volume >= 0 ? volume : 0,
  };
}

/**
 * Parse the OHLCV envelope from the stats/volume proxy. Accepts both the raw
 * `{ ohlcv: [...] }` body and the unwrapped `{ data: { ohlcv: [...] } }`
 * envelope so it tolerates whichever shape the proxy returns, then sorts
 * ascending and de-duplicates timestamps (lightweight-charts requires strictly
 * increasing, unique times). Returns an empty array for an honest no-history
 * response - never a placeholder candle.
 */
function parseOhlcv(json: unknown): Candle[] {
  const root =
    json && typeof json === "object" && "data" in (json as Record<string, unknown>)
      ? (json as { data?: unknown }).data
      : json;
  const list =
    root && typeof root === "object"
      ? (root as { ohlcv?: unknown }).ohlcv
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    const candle = rowToCandle(row);
    if (candle) out.push(candle);
  }
  out.sort((a, b) => (a.time as number) - (b.time as number));
  const deduped: Candle[] = [];
  let prev = -Infinity;
  for (const c of out) {
    const t = c.time as number;
    if (t <= prev) continue;
    prev = t;
    deduped.push(c);
  }
  return deduped;
}

/**
 * Candlestick / area price chart for a Ponk Clouds pool.
 *
 * Loads real OHLCV history from the backend via the same-origin proxy, draws it
 * with a paired volume histogram, overlays the live streamed price as a dashed
 * line, and tracks a crosshair OHLC legend. Renders honest loading / empty /
 * error states instead of ever fabricating price data.
 */
export function PriceChart({
  pool,
  symbol,
  quoteSymbol = "USDC",
  livePrice = null,
  activePrice = null,
  height = 460,
}: PriceChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<"Candlestick" | "Area"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const liveLineRef = useRef<IPriceLine | null>(null);
  const dataRef = useRef<Candle[]>([]);

  const [tfKey, setTfKey] = useState<TfKey>("1H");
  const [type, setType] = useState<ChartType>("Candles");
  const [state, setState] = useState<LoadState>("loading");
  // Headline last + change are derived from the loaded candles; the live tick
  // (when present) takes precedence for the displayed price.
  const [lastClose, setLastClose] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);
  const [legend, setLegend] = useState<Candle | null>(null);

  // Create the chart exactly once; series are (re)created on type change.
  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9494a3", // --muted
        fontSize: 11,
        fontFamily: "var(--font-mono), ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.26 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 8,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(236,72,153,0.4)",
          width: 1,
          labelBackgroundColor: "#16161d",
        },
        horzLine: {
          color: "rgba(236,72,153,0.4)",
          labelBackgroundColor: "#16161d",
        },
      },
    });
    const vol = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    chartRef.current = chart;
    volRef.current = vol;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || dataRef.current.length === 0) {
        setLegend(null);
        return;
      }
      const idx = dataRef.current.findIndex((d) => d.time === param.time);
      setLegend(idx >= 0 ? dataRef.current[idx] : null);
    });

    // The chart lives in a flex column that can resize; refit (rAF-debounced)
    // whenever the container box changes so the candles always fill the width.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (dataRef.current.length > 0) chart.timeScale().fitContent();
      });
    });
    ro.observe(wrapRef.current);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
      liveLineRef.current = null;
    };
  }, []);

  // (Re)create the main series whenever the chart type changes, then repaint the
  // currently-loaded candles into the new series shape.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (mainRef.current) {
      chart.removeSeries(mainRef.current);
      mainRef.current = null;
      liveLineRef.current = null;
    }
    if (type === "Area") {
      mainRef.current = chart.addAreaSeries({
        lineColor: PINK,
        topColor: "rgba(236,72,153,0.22)",
        bottomColor: "rgba(236,72,153,0)",
        lineWidth: 2,
        priceLineVisible: false,
      });
    } else {
      mainRef.current = chart.addCandlestickSeries({
        upColor: UP,
        downColor: DOWN,
        wickUpColor: UP,
        wickDownColor: DOWN,
        borderVisible: false,
        priceLineVisible: false,
      });
    }
    paintMain();
    chart.timeScale().fitContent();
    // paintMain is stable for our purposes; only the type drives re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // Paint the in-ref candles onto whichever main series exists, choosing the
  // right point shape for candlestick vs area. Also sets axis precision from the
  // latest close so sub-dollar pools get enough decimals.
  function paintMain() {
    const series = mainRef.current;
    const raw = dataRef.current;
    if (!series || raw.length === 0) return;
    const small = (raw[raw.length - 1]?.close ?? 1) < 1;
    series.applyOptions({
      priceFormat: {
        type: "price",
        precision: small ? 6 : 2,
        minMove: small ? 0.000001 : 0.01,
      },
    });
    if (type === "Area") {
      (series as ISeriesApi<"Area">).setData(
        raw.map((d) => ({ time: d.time, value: d.close })),
      );
    } else {
      (series as ISeriesApi<"Candlestick">).setData(
        raw.map((d) => ({
          time: d.time,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        })),
      );
    }
  }

  // Load OHLCV whenever the pool or resolution changes. Cancels in-flight loads
  // on change/unmount so a slow response cannot overwrite a newer one.
  useEffect(() => {
    if (!pool) {
      setState("empty");
      return;
    }
    const sel = TFS.find((t) => t.key === tfKey) ?? TFS[2];
    let cancelled = false;
    setState("loading");
    (async () => {
      try {
        const search = new URLSearchParams({
          resource: "volume",
          pool,
          tf: sel.tf,
          agg: String(sel.agg),
        });
        const res = await fetch(`/api/stats?${search.toString()}`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (cancelled) return;
        const candles = parseOhlcv(json);
        dataRef.current = candles;
        if (candles.length === 0) {
          setState("empty");
          setLastClose(null);
          setChangePct(null);
          volRef.current?.setData([]);
          return;
        }
        volRef.current?.setData(
          candles.map((d) => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open ? UP_VOL : DOWN_VOL,
          })),
        );
        paintMain();
        chartRef.current?.timeScale().fitContent();
        const first = candles[0].open;
        const close = candles[candles.length - 1].close;
        setLastClose(close);
        setChangePct(first > 0 ? ((close - first) / first) * 100 : null);
        setState("ready");
      } catch {
        if (!cancelled) {
          setState("error");
          setLastClose(null);
          setChangePct(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, tfKey]);

  // Overlay the live streamed price as a dashed price line on the main series.
  // Re-drawn whenever the tick changes; cleared (and never faked) when the feed
  // reports no price. Only meaningful once the main series exists with data.
  useEffect(() => {
    const series = mainRef.current;
    if (!series) return;
    if (liveLineRef.current) {
      series.removePriceLine(liveLineRef.current);
      liveLineRef.current = null;
    }
    if (
      state !== "ready" ||
      livePrice === null ||
      livePrice === undefined ||
      !Number.isFinite(livePrice) ||
      livePrice <= 0
    ) {
      return;
    }
    liveLineRef.current = series.createPriceLine({
      price: livePrice,
      color: PINK,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "live",
    });
  }, [livePrice, state, type]);

  // The displayed headline price prefers the live tick, then the crosshair
  // legend close, then the last candle close. Each is real; null stays "--".
  const headPrice = useMemo(() => {
    if (livePrice !== null && livePrice !== undefined && Number.isFinite(livePrice) && livePrice > 0) {
      return livePrice;
    }
    if (legend) return legend.close;
    return lastClose;
  }, [livePrice, legend, lastClose]);

  const view = legend;
  const viewUp = view ? view.close >= view.open : true;
  const showChart = state === "ready";

  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-line bg-panel p-4"
      style={{ minHeight: height }}
    >
      {/* header: price, 24h-ish change, pair, controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular-nums text-fg">
            {headPrice !== null ? `$${fmtPrice(headPrice)}` : "--"}
          </span>
          {changePct !== null ? (
            <span
              className={cx(
                "rounded-md px-1.5 py-0.5 font-mono text-[12px] font-medium tabular-nums",
                changePct >= 0 ? "bg-positive/10 text-positive" : "bg-negative/10 text-negative",
              )}
            >
              {changePct >= 0 ? "+" : ""}
              {changePct.toFixed(2)}%
            </span>
          ) : null}
          <span className="ml-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">
            {(symbol ?? "TOKEN")}/{quoteSymbol} - market ref
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-elevated p-0.5">
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cx(
                  "rounded-md px-2 py-1 text-[11px] transition-colors",
                  type === t ? "bg-pink/15 text-pink" : "text-muted hover:text-fg",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-elevated p-0.5">
            {TFS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTfKey(t.key)}
                className={cx(
                  "rounded-md px-2 py-1 font-mono text-[11px] transition-colors",
                  tfKey === t.key ? "bg-pink/15 text-pink" : "text-muted hover:text-fg",
                )}
              >
                {t.key}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* chart canvas + overlays */}
      <div className="relative min-h-0 flex-1" style={{ minHeight: height - 80 }}>
        {/* crosshair OHLC legend */}
        {view ? (
          <div className="pointer-events-none absolute left-3 top-2.5 z-10 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
            {(
              [
                ["O", view.open],
                ["H", view.high],
                ["L", view.low],
                ["C", view.close],
              ] as const
            ).map(([k, v]) => (
              <span key={k} className={cx(viewUp ? "text-positive" : "text-negative")}>
                <span className="text-muted">{k}</span> {fmtPrice(v)}
              </span>
            ))}
            <span className="text-muted">Vol {fmtVol(view.volume)}</span>
          </div>
        ) : null}

        <div
          ref={wrapRef}
          className={cx(
            "h-full min-h-[260px] w-full overflow-hidden rounded-lg border border-line bg-bg",
            showChart ? "" : "opacity-0",
          )}
        />

        {/* honest non-ready states layered over the (hidden) canvas */}
        {!showChart ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-line bg-bg px-6 text-center">
            <ChartState state={state} activePrice={activePrice} quoteSymbol={quoteSymbol} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The non-ready chart surface: loading spinner, an honest "no trades yet" empty
 * state (optionally showing the pool's on-chain active price, clearly labelled
 * as the AMM quote rather than a trade), or an error. Never draws a fake line.
 */
function ChartState({
  state,
  activePrice,
  quoteSymbol,
}: {
  state: LoadState;
  activePrice: number | null;
  quoteSymbol: string;
}) {
  if (state === "loading") {
    return (
      <span className="inline-flex items-center gap-2 text-[12px] text-muted">
        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line border-t-pink" />
        loading market data
      </span>
    );
  }
  if (state === "error") {
    return <p className="m-0 text-[12px] text-negative">price feed unavailable</p>;
  }
  // empty: the pool has no trade history yet. Show the AMM active price if the
  // parent supplied it, labelled so it is never mistaken for a traded price.
  return (
    <div className="flex max-w-[340px] flex-col items-center gap-1.5">
      <span className="text-[13px] font-medium text-fg">No trades yet</span>
      {activePrice !== null && Number.isFinite(activePrice) && activePrice > 0 ? (
        <p className="m-0 text-[12px] leading-relaxed text-muted">
          The on-chain AMM price is{" "}
          <span className="font-mono text-fg">
            ${fmtPrice(activePrice)} {quoteSymbol}
          </span>
          . Candles appear here after the first swap. Nothing is estimated.
        </p>
      ) : (
        <p className="m-0 text-[12px] leading-relaxed text-muted">
          This pool has not traded yet. The price chart fills in from real swaps;
          we never backfill or invent candles.
        </p>
      )}
    </div>
  );
}
