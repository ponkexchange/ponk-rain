/**
 * Typed backend client for `@ponkrain/launch`.
 *
 * This is the single import surface the pages use to read indexed Ponk Clouds
 * data: the platform rollup ({@link getStats}), the discovered pool list
 * ({@link getPools}), and a single pool's detail + bin book + 24h metrics
 * ({@link getPool}). Each call hits one of our same-origin `/api/*` proxy routes
 * (or the configured backend directly when running server-side), unwraps the
 * backend's `{ data }` envelope, and narrows the result to the shapes the
 * components consume.
 *
 * HONESTY (the no-fabrication rule, enforced at the read boundary):
 *   - Every money / count metric the indexer has not computed arrives as `null`
 *     and is passed through as `null`; it is never coerced to `0` or a guess.
 *     The leaf formatters render `null` as the shared `--` dash.
 *   - A `pool_not_found` (or any null `data`) from the pool-detail endpoint
 *     returns `null` so callers can 404 honestly rather than render a shell.
 *   - Network / non-OK responses throw, so a caller's `.catch(...)` chooses the
 *     honest empty state (empty stat bar, empty list) instead of this layer
 *     silently inventing one.
 *
 * URL resolution: in the browser the relative `/api/...` path is used directly.
 * On the server (these pages are server components) there is no relative base,
 * so we resolve an absolute origin from, in order, `NEXT_PUBLIC_SITE_URL`, the
 * Vercel-style `VERCEL_URL`, or `http://localhost:<PORT|3100>` (the launch app's
 * dev port). The `/api/*` route then resolves the upstream indexer host and the
 * on-chain fallback, so this client never needs the backend secret itself.
 */

import type { PoolListItem } from "@/components/pools/PoolCard";

/**
 * The platform rollup shape from `GET /clouds/stats` (surfaced same-origin via
 * `/api/stats`). Every figure is `number | null`, where `null` means the
 * indexer has not computed it yet (rendered as `--`), never a fabricated value.
 */
export interface PlatformStats {
  /** Number of discovered Ponk Clouds pools, or null when not yet indexed. */
  poolCount: number | null;
  /** Total value locked across all pools in USD, or null. */
  tvlUsd: number | null;
  /** Trailing-24h swap volume across all pools in USD, or null. */
  volumeUsd: number | null;
  /** Trailing-24h LP + creator fees across all pools in USD, or null. */
  feesUsd: number | null;
  /** All-time swap count, or null when not yet indexed. */
  totalSwaps: number | null;
  /** Distinct trailing-24h swap signers, or null when not yet indexed. */
  activeTraders: number | null;
}

/**
 * The paged pool-list envelope from `GET /clouds/pools` (surfaced same-origin
 * via `/api/pools`). `pools` is always an array; the paging fields echo the
 * request so the browser can drive a pager.
 */
export interface PoolListResponse {
  /** This page of pools (possibly empty). Money metrics are `null` when unindexed. */
  pools: PoolListItem[];
  /** 1-based page number this response represents. */
  page: number;
  /** Page size this response was served at. */
  pageSize: number;
  /** Total matching pools across all pages, or null when the source cannot count. */
  total: number | null;
}

/** Query parameters for {@link getPools}. All optional; the route applies its
 * own defaults and validates `sortBy` against the backend allow-list. */
export interface GetPoolsParams {
  /** 1-based page number. */
  page?: number;
  /** Page size. */
  pageSize?: number;
  /** Sort key, optionally suffixed `:asc` / `:desc` (e.g. `"tvl:desc"`). */
  sortBy?: string;
  /** Free-text search over pair name / symbol / mint. */
  q?: string;
}

/**
 * The backend wraps every response in a `{ data }` envelope. We unwrap it but
 * also accept a bare body (the on-chain fallback in `/api/pools` returns the
 * list object directly), so both shapes flow through the same reader.
 */
interface Envelope<T> {
  data?: T;
}

/**
 * Resolve the absolute origin for a same-origin `/api/...` fetch when running on
 * the server. In the browser this returns `""` so the relative path is used.
 */
function originBase(): string {
  // Browser: relative paths resolve against the current origin.
  if (typeof window !== "undefined") return "";

  // Explicit public site URL wins (set in production deploys).
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site && site.trim() !== "") return site.replace(/\/+$/, "");

  // Vercel provides the deployment host without a scheme.
  const vercel = process.env.VERCEL_URL;
  if (vercel && vercel.trim() !== "") {
    return `https://${vercel.replace(/\/+$/, "")}`;
  }

  // Local dev / self-hosted: the launch app listens on 3100 by default.
  const port = process.env.PORT && process.env.PORT.trim() !== "" ? process.env.PORT : "3100";
  return `http://localhost:${port}`;
}

/**
 * Fetch JSON from a same-origin `/api/...` path and unwrap the `{ data }`
 * envelope. Throws on a non-OK response so callers choose the honest empty
 * state via `.catch(...)`. Always fetches fresh (`no-store`); the `/api/*` route
 * owns any edge caching.
 *
 * @param path Same-origin path beginning with `/api/`.
 * @returns The unwrapped body (`data` when enveloped, else the body itself).
 */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${originBase()}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Envelope<T> | T;
  // Unwrap `{ data }` when present; otherwise the body is already the payload.
  if (body && typeof body === "object" && "data" in body && (body as Envelope<T>).data !== undefined) {
    return (body as Envelope<T>).data as T;
  }
  return body as T;
}

/**
 * Read the platform rollup (`GET /clouds/stats`, via `/api/stats`).
 *
 * Throws on a transport / non-OK error so the home page can degrade to an
 * honest empty stat bar via `.catch(...)`. Every returned figure is
 * `number | null`; a `null` is preserved end-to-end and rendered as `--`.
 */
export async function getStats(): Promise<PlatformStats> {
  return getJson<PlatformStats>("/api/stats");
}

/**
 * Read a page of discovered pools (`GET /clouds/pools`, via `/api/pools`).
 *
 * Forwards `page`, `pageSize`, `sortBy`, and `q` to the proxy route, which
 * validates `sortBy` and either proxies the indexer or discovers pools directly
 * from chain (USD metrics then honestly `null`). Returns the `{ pools, ... }`
 * envelope; `pools` is always an array.
 *
 * @param params Optional paging / sort / search parameters.
 */
export async function getPools(params: GetPoolsParams = {}): Promise<PoolListResponse> {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize));
  if (params.sortBy !== undefined && params.sortBy !== "") search.set("sortBy", params.sortBy);
  if (params.q !== undefined && params.q.trim() !== "") search.set("q", params.q.trim());

  const qs = search.toString();
  const result = await getJson<Partial<PoolListResponse>>(`/api/pools${qs ? `?${qs}` : ""}`);

  // Normalize: the route always sends `pools`, but guard so a malformed body
  // degrades to an honest empty page rather than throwing downstream.
  return {
    pools: Array.isArray(result?.pools) ? (result.pools as PoolListItem[]) : [],
    page: typeof result?.page === "number" ? result.page : (params.page ?? 1),
    pageSize:
      typeof result?.pageSize === "number" ? result.pageSize : (params.pageSize ?? 25),
    total: typeof result?.total === "number" ? result.total : null,
  };
}

/**
 * Read a single pool's detail + bin book + 24h metrics
 * (`GET /clouds/pool/:address`, via `/api/pool/:address`).
 *
 * Returns `null` for a `pool_not_found` (or any null `data`) so the trade /
 * pool routes can 404 honestly instead of rendering a fabricated shell. The
 * returned shape is intentionally `unknown`: each caller narrows it to the
 * detail type it consumes (e.g. `TradePoolDetail`), keeping this client free of
 * a dependency on any one page's view model.
 *
 * @param address Pool PDA address, base58.
 */
export async function getPool(address: string): Promise<unknown | null> {
  const encoded = encodeURIComponent(address);
  const detail = await getJson<unknown>(`/api/pool/${encoded}`);
  return detail ?? null;
}
