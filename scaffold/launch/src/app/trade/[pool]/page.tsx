/**
 * /trade/[pool] - the trading interface for a single Ponk Clouds pool.
 *
 * This is a SERVER component: it resolves the pool from OUR backend
 * (`GET /clouds/pool/:address`, returning the pool, its bin book, and 24h
 * metrics) ahead of paint, so the page renders meaningful content without a
 * client round-trip and is deep-linkable / SEO-friendly. When the backend
 * reports `pool_not_found` (or any null pool), we 404 HONESTLY via Next's
 * {@link notFound} rather than rendering a fabricated shell.
 *
 * The resolved pool is handed to {@link TradePanel}, a thin client wrapper that
 * opens the live SSE market feed (`useCloudsFeed`) and lays out the two-column
 * {@link TradeView}: the price chart + recent-trades tape on the left and the
 * {@link SwapWidget} on the right. Streaming price/last-trade ticks flow from
 * the feed into both columns so the displayed rate and tape stay live without
 * the server component re-rendering.
 *
 * Nothing here invents data: every metric is whatever the backend returned,
 * including `null`, and the leaf formatters render `--` for unknowns.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getPool } from "@/lib/api";
import {
  TradePanel,
  type TradePoolDetail,
} from "@/components/swap/SwapWidget";

/**
 * Per-request route params. Next 14 app-router pages receive `params` as a
 * plain object; `pool` is the pool PDA address from the `[pool]` segment.
 */
interface TradePageProps {
  params: { pool: string };
}

/**
 * Resolve the pool detail for `address` from OUR backend, narrowed to the
 * {@link TradePoolDetail} shape the trade UI consumes. `getPool` unwraps the
 * `{data}` envelope and returns `null` for a `pool_not_found`; we also swallow
 * any transport error to `null` so the route can 404 honestly rather than 500.
 */
async function resolvePool(address: string): Promise<TradePoolDetail | null> {
  const detail = await getPool(address).catch(() => null);
  return (detail as TradePoolDetail | null) ?? null;
}

/**
 * Build the per-pool page metadata from the resolved pool, so a shared
 * `/trade/<addr>` link shows the real pair name. Falls back to a neutral
 * title when the pool cannot be resolved (the page itself then 404s).
 */
export async function generateMetadata({
  params,
}: TradePageProps): Promise<Metadata> {
  const detail = await resolvePool(params.pool);
  if (!detail) {
    return { title: "Trade - Ponk Rain" };
  }
  const { pool } = detail;
  const symX = pool.tokenX.symbol || pool.tokenX.address.slice(0, 4);
  const symY = pool.tokenY.symbol || pool.tokenY.address.slice(0, 4);
  return {
    title: `Trade ${pool.name} - Ponk Rain`,
    description: `Swap ${symX} and ${symY} on the ${pool.name} Ponk Clouds DLMM pool.`,
  };
}

/**
 * The trade route. Resolves the pool server-side and renders the live trade
 * panel, or 404s when the address is not a Ponk Clouds pool.
 */
export default async function TradePage({ params }: TradePageProps) {
  // Resolve the pool + bin book + 24h metrics. On a pool_not_found (null) we
  // surface a real 404 rather than rendering a fabricated shell.
  const detail = await resolvePool(params.pool);
  if (!detail) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <TradePanel pool={detail} />
    </main>
  );
}
