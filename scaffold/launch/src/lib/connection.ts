/**
 * The Ponk Clouds web3.js {@link Connection} for the launch app, built from
 * NEXT_PUBLIC_PONK_CLOUDS_RPC at the `"confirmed"` commitment. Mirrors the dex
 * `ponkCloudsConnection()` so transaction building (pool-create, swap, liquidity)
 * talks to the same cluster the wallet adapter connects to.
 *
 * The endpoint is also exported as {@link CLOUDS_RPC_ENDPOINT} for the
 * wallet-adapter `ConnectionProvider`, so the provider and the imperative
 * SDK/tx-building path always agree on one RPC.
 *
 * The connection is memoized: a single instance is reused across the app so we
 * do not open a fresh RPC client per call. The endpoint is read from
 * NEXT_PUBLIC_* env (public, available in both server and browser bundles) with
 * a mainnet-beta fallback matching the dex default.
 */

import { Connection } from "@solana/web3.js";

/**
 * The Solana RPC endpoint the wallet/SDK connect to. A local validator today;
 * mainnet after audit. Read from NEXT_PUBLIC_PONK_CLOUDS_RPC with the same
 * mainnet-beta default the dex uses, so a clone-and-run install works without
 * any env set (against public mainnet RPC).
 */
export const CLOUDS_RPC_ENDPOINT: string =
  process.env.NEXT_PUBLIC_PONK_CLOUDS_RPC ??
  "https://api.mainnet-beta.solana.com";

/** The read/confirm commitment the connection (and the app) operate at. */
export const CLOUDS_COMMITMENT = "confirmed" as const;

let cached: Connection | null = null;

/**
 * The memoized Ponk Clouds {@link Connection} at the `"confirmed"` commitment.
 *
 * Returns the same instance on every call so transaction building, signature
 * confirmation, and on-chain reads share one RPC client. Mirrors the dex
 * `ponkCloudsConnection()`.
 */
export function ponkCloudsConnection(): Connection {
  if (cached === null) {
    cached = new Connection(CLOUDS_RPC_ENDPOINT, CLOUDS_COMMITMENT);
  }
  return cached;
}
