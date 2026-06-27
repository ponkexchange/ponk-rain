/**
 * GET /api/pools - same-origin proxy + on-chain fallback for the pool list.
 *
 * The browser hits this route instead of the backend directly, which avoids
 * CORS, keeps the upstream host (`API_URL`) server-resolved, and lets us add a
 * short cache. The primary path is a verbatim proxy to the backend clouds
 * indexer (`GET {API_URL}/clouds/pools`), forwarding `page`, `pageSize`,
 * `sortBy`, and `q`; the upstream `{ data: ... }` envelope is returned unchanged
 * so `lib/api.ts` can unwrap it exactly as it does for a direct call.
 *
 * Fallback (the "proxy SDK discovery" half of the job): when no `API_URL` /
 * `NEXT_PUBLIC_API_URL` is configured, or the backend is unreachable, the route
 * discovers pools DIRECTLY FROM CHAIN via the SDK (`discoverPools`) so a fresh
 * clone-and-run shows the real, live Ponk Clouds pools without an indexer
 * running. The on-chain path fills only the fields chain actually knows -
 * identity (address, pair, mints, decimals), bin step, base fee, creator
 * protocol fee, and the current price from the active bin - and leaves every
 * USD / volume / APR metric `null` (rendered as `--`). Nothing is fabricated:
 * the indexer is the only source of dollar metrics, and without it those stay
 * honestly empty.
 *
 * Server-only route handler (it opens an RPC connection and reads `process.env`
 * secrets), so it must run on the Node.js runtime.
 */

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  discoverPools,
  fetchPoolByAddress,
  priceOfBin,
  NATIVE_MINT_STR,
  type PoolInfo,
} from "@ponkrain/sdk";

/** Node runtime: the SDK fallback opens a web3.js Connection. */
export const runtime = "nodejs";

/**
 * Default RPC for the on-chain fallback. Mirrors the dex / SDK default; an
 * operator overrides it with `NEXT_PUBLIC_PONK_CLOUDS_RPC` (a local validator
 * today, mainnet after audit).
 */
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * The sort keys the backend `/clouds/pools` endpoint accepts. Mirrors the
 * design spec's allow-list. A `sortBy` that is not one of these (optionally
 * suffixed with `:asc` / `:desc`) is dropped before forwarding so a bad value
 * cannot reach the upstream as an unhandled query.
 */
const SORT_ALLOW_LIST = new Set([
  "tvl",
  "volume24h",
  "fees24h",
  "feeTvlRatio24h",
  "apr",
  "binStep",
  "createdAt",
]);

/** Short edge cache: pools change on the order of seconds, not milliseconds. */
const CACHE_CONTROL = "public, s-maxage=15, stale-while-revalidate=30";

/** Resolve the server-side backend base URL, or null when none is configured. */
function backendBase(): string | null {
  const base = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  return base && base.trim() !== "" ? base.replace(/\/+$/, "") : null;
}

/**
 * Keep only the allow-listed query params, validating the `sortBy` against
 * {@link SORT_ALLOW_LIST}. Returns a clean `URLSearchParams` to forward.
 */
function forwardableParams(incoming: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const page = incoming.get("page");
  const pageSize = incoming.get("pageSize");
  const q = incoming.get("q");
  const sortBy = incoming.get("sortBy");

  if (page && /^\d+$/.test(page)) out.set("page", page);
  if (pageSize && /^\d+$/.test(pageSize)) out.set("pageSize", pageSize);
  if (q && q.trim() !== "") out.set("q", q.trim());
  if (sortBy) {
    const [key] = sortBy.split(":");
    if (key && SORT_ALLOW_LIST.has(key)) out.set("sortBy", sortBy);
  }
  return out;
}

/** A pool-list item with on-chain identity and honest-null metrics. Matches the
 * `PoolListItem` shape the `PoolCard` / `PoolList` components consume. */
interface OnChainPoolItem {
  address: string;
  name: string;
  tokenX: { address: string; symbol: string; name: string; logoUri: string | null };
  tokenY: { address: string; symbol: string; name: string; logoUri: string | null };
  binStep: number;
  baseFeePct: number | null;
  protocolFeePct: number | null;
  currentPrice: number | null;
  tvlUsd: null;
  volume24hUsd: null;
  fees24hUsd: null;
  apr: null;
  tags: string[];
}

/** Honest symbol: the resolver fallback already gives a short-mint label, but
 * never surface a wSOL pool leg as the raw long mint. */
function legSymbol(info: PoolInfo, side: "X" | "Y"): string {
  return side === "X" ? info.symbolX : info.symbolY;
}

/**
 * Build the list envelope straight from chain when no indexer is reachable.
 * Discovers every pool, then batch-reads each pool account to fill the base /
 * creator fee and current price from the active bin. USD metrics stay null.
 */
async function discoverFromChain(
  incoming: URLSearchParams,
): Promise<{ pools: OnChainPoolItem[]; page: number; pageSize: number; total: number; source: "onchain" }> {
  const rpc = process.env.NEXT_PUBLIC_PONK_CLOUDS_RPC ?? DEFAULT_RPC;
  const conn = new Connection(rpc, "confirmed");

  // Discover identity for every pool. Symbols fall back to short-mint labels.
  const infos = await discoverPools(conn, {
    resolveSymbol: (mint) => (mint === NATIVE_MINT_STR ? "SOL" : null),
  });

  // Read each pool account once to recover fee bps + active bin (and thus
  // price). These are real on-chain values, not estimates.
  const decoded = await Promise.all(
    infos.map(async (info) => {
      try {
        const pool = await fetchPoolByAddress(conn, new PublicKey(info.address));
        if (!pool) return { info, baseFeePct: null, protocolFeePct: null, price: null };
        const price = priceOfBin(
          pool.activeBinId,
          pool.binStepBps,
          info.decimalsX,
          info.decimalsY,
        );
        return {
          info,
          baseFeePct: pool.swapFeeBps / 100,
          protocolFeePct: pool.protocolFeeBps / 100,
          price: Number.isFinite(price) && price > 0 ? price : null,
        };
      } catch {
        return { info, baseFeePct: null, protocolFeePct: null, price: null };
      }
    }),
  );

  let items: OnChainPoolItem[] = decoded.map(({ info, baseFeePct, protocolFeePct, price }) => ({
    address: info.address,
    name: info.name,
    tokenX: { address: info.mintX, symbol: legSymbol(info, "X"), name: "", logoUri: null },
    tokenY: { address: info.mintY, symbol: legSymbol(info, "Y"), name: "", logoUri: null },
    binStep: info.binStep,
    baseFeePct,
    protocolFeePct,
    currentPrice: price,
    tvlUsd: null,
    volume24hUsd: null,
    fees24hUsd: null,
    apr: null,
    tags: ["zero-protocol-fee"],
  }));

  // Optional client-side search over the pair name / mints, mirroring `q`.
  const q = incoming.get("q")?.trim().toLowerCase();
  if (q) {
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.tokenX.address.toLowerCase().includes(q) ||
        p.tokenY.address.toLowerCase().includes(q) ||
        p.tokenX.symbol.toLowerCase().includes(q) ||
        p.tokenY.symbol.toLowerCase().includes(q),
    );
  }

  // Only `binStep` is sortable without indexed metrics; everything else needs
  // the indexer. Default and any metric sort fall back to binStep ascending so
  // the order is at least deterministic (never a fabricated TVL ranking).
  const sortBy = incoming.get("sortBy") ?? "";
  const [sortKey, sortDirRaw] = sortBy.split(":");
  const dir = sortDirRaw === "asc" ? 1 : -1;
  if (sortKey === "binStep") {
    items.sort((a, b) => (a.binStep - b.binStep) * dir);
  }

  // Page the in-memory list the same way the backend would.
  const total = items.length;
  const page = Math.max(1, Number(incoming.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    200,
    Math.max(1, Number(incoming.get("pageSize") ?? "50") || 50),
  );
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  return { pools: paged, page, pageSize, total, source: "onchain" };
}

/**
 * GET handler: proxy to the backend when configured, otherwise discover pools
 * from chain. Either way the response is the `{ pools, ... }` envelope the pool
 * list expects, with a short edge cache.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const incoming = new URL(req.url).searchParams;
  const base = backendBase();

  if (base) {
    const params = forwardableParams(incoming);
    const upstream = `${base}/clouds/pools${params.toString() ? `?${params}` : ""}`;
    try {
      const res = await fetch(upstream, {
        headers: { accept: "application/json" },
        // Always fetch fresh from the indexer on the server; the short edge
        // cache is driven by the Cache-Control header we set on the response
        // below (s-maxage), not by Next's data cache. This keeps the proxy a
        // thin, standards-only pass-through.
        cache: "no-store",
      });
      if (res.ok) {
        // Return the upstream envelope verbatim (do not reshape the backend's
        // `{ data }` wrapper), only stamping our own cache header.
        const body = await res.text();
        return new NextResponse(body, {
          status: 200,
          headers: {
            "content-type": res.headers.get("content-type") ?? "application/json",
            "cache-control": CACHE_CONTROL,
          },
        });
      }
      // A non-OK upstream is a real error from the indexer: pass its status and
      // body through rather than masking it with the on-chain fallback (the
      // fallback is for "no indexer", not "indexer said 4xx/5xx").
      const body = await res.text().catch(() => "");
      return new NextResponse(body || JSON.stringify({ error: "upstream error" }), {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
        },
      });
    } catch {
      // The backend host is configured but unreachable (down, DNS, network).
      // Fall through to the on-chain discovery path so the list still loads.
    }
  }

  // No backend configured, or it was unreachable: discover from chain.
  try {
    const data = await discoverFromChain(incoming);
    return NextResponse.json(data, {
      status: 200,
      headers: { "cache-control": CACHE_CONTROL },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to load pools";
    return NextResponse.json({ error: message, pools: [] }, { status: 502 });
  }
}
