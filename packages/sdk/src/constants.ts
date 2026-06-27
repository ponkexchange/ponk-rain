/**
 * Program-level constants, addresses, and Anchor discriminators for the
 * Ponk Clouds program (id DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M), a
 * bin-based DLMM AMM with ZERO protocol fee at the AMM level.
 *
 * This module is the single source of truth for every magic number the SDK
 * needs: bin-array geometry, fee caps, compute-unit limits, account sizes,
 * and the 8-byte Anchor discriminators. No other module re-derives these.
 *
 * Every value here is ported verbatim from the real sources:
 *   - dex-web/lib/ponkclouds.ts (PDAs, decoders, instruction builders),
 *   - ponk-clouds/programs/ponk-clouds/src/lib.rs (program id, fee caps,
 *     MAX_SWAP_BIN_ARRAYS, DEFAULT_TREASURY, DEFAULT_TREASURY_FEE_BPS),
 *   - ponk-clouds/programs/ponk-clouds/src/state.rs (account layouts),
 *   - ponk-clouds/crates/clouds-math/src/router.rs (MAX_BINS_PER_SWAP).
 *
 * The discriminators were verified by recomputing sha256("global:<name>"),
 * sha256("account:<Name>") and cross-checking against the precomputed set in
 * ponkclouds.ts; they match byte-for-byte.
 *
 * All PublicKeys are constructed eagerly from base58 string literals. The
 * program id is a constant here; it is overridable only via an explicit
 * options object passed to RainClient, never via the environment, because
 * this is an environment-agnostic SDK.
 */

import { PublicKey } from "@solana/web3.js";

/** The Ponk Clouds program id (mainnet/devnet deployment address). */
export const PONK_CLOUDS_PROGRAM_ID: PublicKey = new PublicKey(
  "DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M",
);

/** The SPL Token program. Vaults and user token accounts live under it. */
export const TOKEN_PROGRAM_ID: PublicKey = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/** The Associated Token Account program. ATAs (vaults, user accounts) derive
 * under it. */
export const ASSOCIATED_TOKEN_PROGRAM_ID: PublicKey = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Wrapped SOL (wSOL) mint. Native SOL is wrapped into this for swaps and
 * deposits, then unwrapped on exit. */
export const NATIVE_MINT: PublicKey = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

/** Base58 of {@link NATIVE_MINT}, for cheap string comparisons (e.g. when a
 * mint is already a string and we only need to know if it is wSOL). */
export const NATIVE_MINT_STR: string = NATIVE_MINT.toBase58();

/**
 * The program's DEFAULT_TREASURY: the PONK platform fee wallet a new
 * per-pool treasury config points at when created. Ported from lib.rs
 * `DEFAULT_TREASURY`. The authority can change it later via set_treasury.
 */
export const DEFAULT_TREASURY: PublicKey = new PublicKey(
  "7nNPreWHRmKNbr8AUHFRttVw6fPFAQhVT1tfrYZ7685K",
);

/**
 * The program's DEFAULT_TREASURY_FEE_BPS: a newly created treasury config
 * withholds 1% (100 bps) OF THE SWAP FEE for the platform. Ported from
 * lib.rs `DEFAULT_TREASURY_FEE_BPS`.
 */
export const DEFAULT_TREASURY_FEE_BPS = 100;

/** Bins per BinArray account. Ported from state.rs `BINS_PER_ARRAY`. A swap
 * loads the arrays it needs; this bounds account size and compute. */
export const BINS_PER_ARRAY = 70;

/**
 * On-chain cap on how many BinArrays a single swap may load: the named
 * `bin_array` plus up to MAX_SWAP_BIN_ARRAYS-1 remaining arrays. Ported from
 * lib.rs `MAX_SWAP_BIN_ARRAYS` (value 2, so a swap covers up to 140
 * contiguous bins). NOTE: this is deliberately 2, not the 3 the older
 * dex-web copy carried: the on-chain program was re-measured and lowered the
 * cap to keep the worst-case swap under the 200k CU budget. Do NOT raise it.
 */
export const MAX_SWAP_BIN_ARRAYS = 2;

/**
 * The clouds-math walk bound: a single swap walks at most this many bins
 * before stopping (the binding compute constraint). Ported from
 * clouds-math/src/router.rs `MAX_BINS_PER_SWAP`.
 */
export const MAX_BINS_PER_SWAP = 28;

/**
 * Minimum total liquidity (reserve_x + reserve_y) the very first deposit into
 * a bin must seed. Below this the program reverts with BelowMinLiquidity.
 * Ported from clouds-math/src/liquidity.rs (the MIN_LIQUIDITY floor mirrored
 * in ponkclouds.ts `previewDeposit`).
 */
export const MIN_LIQUIDITY = 1000n;

/** Hard cap on the swap fee (bps OF the trade). Ported from lib.rs
 * `MAX_SWAP_FEE_BPS` (10%). The authority cannot exceed it. */
export const MAX_SWAP_FEE_BPS = 1000;

/** Hard cap on the protocol fee (bps OF the swap fee). Ported from lib.rs
 * `MAX_PROTOCOL_FEE_BPS`. Guarantees LPs always keep at least half the fee. */
export const MAX_PROTOCOL_FEE_BPS = 5000;

/** Hard cap on the treasury fee (bps OF the swap fee). Ported from lib.rs
 * `MAX_TREASURY_FEE_BPS`. The math jointly clamps protocol + treasury <= the
 * whole fee; this independently bounds the platform's own share. */
export const MAX_TREASURY_FEE_BPS = 5000;

/**
 * Exact on-chain byte size of a Pool account, used as the `dataSize` filter
 * that isolates pools in getProgramAccounts discovery. Ported from the
 * POOL_ACCOUNT_SIZE constant in ponkclouds.ts: 8 disc + 5 pubkeys (160) +
 * 3 u16 (6) + i32 (4) + bool (1) + u8 (1) + 2 u128 (32) = 212. Unique among
 * the program's account types (BinArray and PoolTreasury differ), so the
 * filter cannot match a non-Pool account.
 */
export const POOL_ACCOUNT_SIZE = 212;

/**
 * Compute-unit ceiling prepended to every Clouds swap transaction. Ported
 * from ponkclouds.ts `CLOUDS_SWAP_CU_LIMIT`. 200_000 is the per-instruction
 * default and sits above the measured worst-case multi-array swap, giving
 * headroom without overpaying priority fees.
 */
export const CLOUDS_SWAP_CU_LIMIT = 200000;

/**
 * Compute-unit ceiling for the create-pool transaction (two vault ATA
 * creations + initialize_pool). Ported from ponkclouds.ts
 * `CLOUDS_CREATE_CU_LIMIT`. Measured ~37-53k CU on live pairs; 80_000 gives
 * comfortable headroom and makes the tx's CU accounting wallet-independent.
 */
export const CLOUDS_CREATE_CU_LIMIT = 80000;

/**
 * Lamports kept back when a user taps "max" on a native-SOL input. Wrapping
 * SOL costs the network fee plus ~0.00204 SOL of account rent; spending the
 * literal full balance leaves nothing for those and the wrap fails. ~0.02 SOL
 * is a safe buffer. Ported from ponkclouds.ts `SOL_MAX_RESERVE_LAMPORTS`.
 */
export const SOL_MAX_RESERVE_LAMPORTS = 20000000n;

/** Basis-point denominator (10_000). One bps = 1/10_000. */
export const BPS_DENOM = 10000n;

/** The Q64.64 fixed-point unit (1 << 64). Bin prices are expressed in this
 * scale on the exact integer pricing path (clouds-math). */
export const Q64 = 1n << 64n;

/**
 * 8-byte Anchor instruction discriminators = sha256("global:<snake_name>")[..8].
 *
 * These cover the lifecycle instructions the SDK builds. Ported verbatim from
 * the precomputed `DISC` map in ponkclouds.ts and re-verified by hashing the
 * instruction names from lib.rs:
 *   initialize_pool, initialize_bin_array, initialize_position,
 *   add_liquidity, remove_liquidity, close_position, swap, init_pool_treasury,
 *   claim_protocol_fees, claim_treasury_fees.
 *
 * The fee-claim discriminators are computed here so the fees module never
 * re-hashes them, matching the design's single-source-of-truth rule.
 */
export const DISCRIMINATORS: Readonly<
  Record<
    | "initializePool"
    | "initBinArray"
    | "initPosition"
    | "addLiquidity"
    | "removeLiquidity"
    | "closePosition"
    | "swap"
    | "initPoolTreasury"
    | "claimProtocolFees"
    | "claimTreasuryFees",
    Uint8Array
  >
> = Object.freeze({
  // sha256("global:initialize_pool")[..8]
  initializePool: Uint8Array.from([0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28]),
  // sha256("global:initialize_bin_array")[..8]
  initBinArray: Uint8Array.from([0x23, 0x56, 0x13, 0xb9, 0x4e, 0xd4, 0x4b, 0xd3]),
  // sha256("global:initialize_position")[..8]
  initPosition: Uint8Array.from([0xdb, 0xc0, 0xea, 0x47, 0xbe, 0xbf, 0x66, 0x50]),
  // sha256("global:add_liquidity")[..8]
  addLiquidity: Uint8Array.from([0xb5, 0x9d, 0x59, 0x43, 0x8f, 0xb6, 0x34, 0x48]),
  // sha256("global:remove_liquidity")[..8]
  removeLiquidity: Uint8Array.from([0x50, 0x55, 0xd1, 0x48, 0x18, 0xce, 0xb1, 0x6c]),
  // sha256("global:close_position")[..8]
  closePosition: Uint8Array.from([0x7b, 0x86, 0x51, 0x00, 0x31, 0x44, 0x62, 0x62]),
  // sha256("global:swap")[..8]
  swap: Uint8Array.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]),
  // sha256("global:init_pool_treasury")[..8]
  initPoolTreasury: Uint8Array.from([0xe9, 0x24, 0xf8, 0x16, 0xc2, 0x3e, 0x5b, 0x4a]),
  // sha256("global:claim_protocol_fees")[..8]
  claimProtocolFees: Uint8Array.from([0x22, 0x8e, 0xdb, 0x70, 0x6d, 0x36, 0x85, 0x17]),
  // sha256("global:claim_treasury_fees")[..8]
  claimTreasuryFees: Uint8Array.from([0x4f, 0xfb, 0x3f, 0x63, 0xf0, 0xd7, 0x00, 0xfc]),
});

/**
 * 8-byte Anchor account discriminators = sha256("account:<Name>")[..8], used
 * to detect which account type a raw buffer holds before decoding. Verified
 * by hashing the #[account] struct names from state.rs.
 */

/** sha256("account:Pool")[..8] */
export const POOL_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc,
]);

/** sha256("account:BinArray")[..8] */
export const BIN_ARRAY_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0x5c, 0x8e, 0x5c, 0xdc, 0x05, 0x94, 0x46, 0xb5,
]);

/** sha256("account:Position")[..8] */
export const POSITION_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0,
]);

/** sha256("account:PoolTreasury")[..8] */
export const POOL_TREASURY_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0x97, 0x1e, 0xcf, 0x25, 0x16, 0xe8, 0xaf, 0x17,
]);
