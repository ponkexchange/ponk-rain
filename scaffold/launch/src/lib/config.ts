/**
 * Static, non-secret app configuration for `@ponkrain/launch`.
 *
 * Everything here is a compile-time constant or a value derived only from
 * NEXT_PUBLIC_* env (which is itself public): the brand name, the Ponk Clouds
 * program id default, the canonical mints, the create-market presets (bin step,
 * base fee, creator protocol fee), the supported wallet list, and pagination
 * defaults. Presets live in ONE place so the LaunchForm and the pool lists stay
 * in lockstep with the dex `rain/clouds/standard` create page they mirror.
 *
 * No secrets are read here. Server-only secrets and zod-validated runtime env
 * live in `./env`; this module is safe to import from both server and client
 * components.
 */

import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@ponkrain/sdk";

/** The product name. The DLMM venue is "Ponk Clouds"; the act of creating one
 * is "Ponk Rain". This is the launch kit's brand. */
export const BRAND_NAME = "Ponk Rain";

/** The DLMM venue brand the markets run on. */
export const VENUE_NAME = "Ponk Clouds";

/**
 * The real deployed Ponk Clouds program id. Overridable only via
 * NEXT_PUBLIC_PONK_CLOUDS_PROGRAM (e.g. for a local/devnet redeploy); when the
 * override is unset or invalid this canonical default is used.
 *
 * The SDK's PDA helpers are bound to this same id at compile time, so the
 * override is for display/metadata and same-id deployments only.
 */
export const DEFAULT_PROGRAM_ID = "DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M";

/** The Ponk Clouds program id as a base58 string, resolved from
 * NEXT_PUBLIC_PONK_CLOUDS_PROGRAM with a fallback to {@link DEFAULT_PROGRAM_ID}.
 * Falls back to the default if the override is not a valid pubkey. */
export const PROGRAM_ID_STR: string = (() => {
  const override = process.env.NEXT_PUBLIC_PONK_CLOUDS_PROGRAM;
  if (override) {
    try {
      return new PublicKey(override).toBase58();
    } catch {
      // Invalid override: fall through to the canonical default rather than
      // crashing the bundle. The default is always a valid program id.
    }
  }
  return DEFAULT_PROGRAM_ID;
})();

/** The Ponk Clouds program id as a {@link PublicKey}. */
export const PROGRAM_ID: PublicKey = new PublicKey(PROGRAM_ID_STR);

/** Wrapped SOL mint (native SOL is wrapped into this for swaps/deposits). The
 * SDK is the single source of truth; re-exported here so config consumers have
 * one import surface for the canonical mints. */
export const NATIVE_MINT_STR: string = NATIVE_MINT.toBase58();

/** USDC mint on Solana mainnet, the default quote token in the create flow. */
export const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Decimals for the canonical mints (wSOL is always 9 dp, USDC 6 dp). */
export const NATIVE_DECIMALS = 9;
export const USDC_DECIMALS = 6;

/**
 * Bin step presets in bps, mirroring the dex create page. Smaller steps
 * concentrate liquidity tighter (lower slippage, narrower range per bin); larger
 * steps span a wider price range per bin. The live SOL/USDC Clouds pool runs at
 * 4 bps, so 4 is the default.
 */
export const BIN_STEP_PRESETS = [1, 2, 4, 5, 10, 20, 50, 100] as const;

/** Default bin step (bps) the LaunchForm opens on. */
export const DEFAULT_BIN_STEP = 4;

/**
 * Base (swap) fee tier presets in bps: the fee a trader pays the pool per swap,
 * shared between LPs and (via the protocol/treasury cuts) the creator and
 * platform. Mirrors the dex create page presets.
 */
export const BASE_FEE_PRESETS = [1, 4, 5, 10, 30, 100] as const;

/** Default base (swap) fee (bps) the LaunchForm opens on. */
export const DEFAULT_BASE_FEE_BPS = 4;

/**
 * Creator protocol-fee presets: the creator's cut OF the swap fee, in bps
 * (10000 = 100% of the fee). On Ponk this accrues to the POOL CREATOR. 0 means
 * LPs keep the entire fee (minus the platform's flat 1% treasury cut). The
 * default is a modest 20% so a creator earns by default without starving LPs.
 */
export const PROTOCOL_FEE_PRESETS = [0, 1000, 2000, 3000] as const;

/** Default creator protocol fee (bps OF the swap fee). */
export const DEFAULT_PROTOCOL_FEE_BPS = 2000;

/**
 * The platform's flat cut OF the swap fee, in bps (100 = 1%). This is the
 * program's DEFAULT_TREASURY_FEE_BPS, surfaced for honest fee-breakdown copy.
 * It is a slice of the swap fee, never an extra charge on the trade, and there
 * is ZERO protocol fee at the AMM level.
 */
export const PLATFORM_FEE_BPS = 100;

/**
 * The SPL Token-2022 program id. Ponk Clouds supports classic SPL tokens only,
 * so a mint owned by this program is rejected before a create/swap tx is built.
 */
export const TOKEN_2022_PROGRAM_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** The classic SPL Token program id, the only token program Ponk Clouds vaults
 * accept. Used to validate pasted mints in the create/swap flows. */
export const TOKEN_PROGRAM_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Wallet adapters the launch kit offers. Mirrors the WalletProvider stack
 * (Phantom / Solflare / Backpack). The string ids are the adapter `name`s the
 * UI can match against the connected wallet.
 */
export const SUPPORTED_WALLETS = ["Phantom", "Solflare", "Backpack"] as const;

/** Allow-list of server-side sort keys for GET /clouds/pools. The PoolList and
 * /explore page map their sort UI onto exactly these; anything else is ignored
 * server-side. Kept in one place so the list and the proxy agree. */
export const POOL_SORT_KEYS = [
  "tvl",
  "volume24h",
  "fees24h",
  "feeTvlRatio24h",
  "apr",
  "binStep",
  "createdAt",
] as const;

/** A server-side pool sort key. */
export type PoolSortKey = (typeof POOL_SORT_KEYS)[number];

/** Default sort applied on home and /explore. */
export const DEFAULT_POOL_SORT: PoolSortKey = "tvl";

/** Pagination defaults for the pool browser. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** PnL-series ranges the portfolio page can request. */
export const PNL_RANGES = ["24h", "7d", "30d", "all"] as const;

/** A PnL-series range. */
export type PnlRange = (typeof PNL_RANGES)[number];

/** Default PnL-series range. */
export const DEFAULT_PNL_RANGE: PnlRange = "7d";

/** Solscan tx URL for a signature (used by the trade tape and create flow). */
export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

/** Solscan address URL for an account/mint/pool. */
export function solscanAddressUrl(address: string): string {
  return `https://solscan.io/account/${address}`;
}
