/**
 * Ponk Rain: build the transactions that launch a new Ponk Clouds market.
 *
 * "Clouds" is PONK's bin-based DLMM AMM (program id
 * `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`); "Rain" is the act of
 * creating one. This module ports the on-chain `initialize_pool`,
 * `init_pool_treasury`, and `initialize_bin_array` instruction builders from
 * `dex-web/lib/ponkclouds.ts`, with the account order frozen to the program's
 * `InitializePool` / `InitPoolTreasury` / `InitializeBinArray` accounts structs
 * (see `ponk-clouds/programs/ponk-clouds/src/lib.rs`).
 *
 * Key facts ported verbatim from the program:
 *
 *  - The bin step is part of the pool PDA seed
 *    (`[b"pool", mintX, mintY, binStep u16 LE]`), so multiple bin-step pools can
 *    exist per pair.
 *  - Mint order (X = base, Y = quote) is NOT canonicalized by the program; it is
 *    the caller's choice and is part of the pool identity.
 *  - The two vaults are the pool PDA's associated token accounts (owner == pool),
 *    which satisfies the program's `vault.owner == pool` constraint, so they must
 *    be created (idempotent) BEFORE `initialize_pool` runs.
 *  - Fee caps: `bin_step_bps > 0`, `swap_fee_bps <= MAX_SWAP_FEE_BPS` (1000),
 *    `protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS` (5000). We validate locally so a
 *    bad config fails before a signature is requested, not on-chain.
 *  - There is ZERO protocol fee at the AMM level; the protocol/treasury cuts are
 *    a slice OF the swap fee, configured per pool, never an extra trader charge.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLOUDS_CREATE_CU_LIMIT,
  DISCRIMINATORS,
  MAX_PROTOCOL_FEE_BPS,
  MAX_SWAP_FEE_BPS,
  PONK_CLOUDS_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../constants.js";
import { concatBytes, i32le, u16le } from "../codec.js";
import {
  arrayStartForBin,
  ata,
  binArrayPda,
  poolPda,
  poolTreasuryPda,
  vaultPda,
} from "../pda.js";
import { binIdForPrice } from "../math/price.js";
import type { RainParams } from "../types.js";

/** Build an Anchor-style account meta. */
function meta(
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner, isWritable };
}

/**
 * Validate a {@link RainParams} against the program's hard caps BEFORE building
 * any instruction, so a bad config throws a clear local error instead of an
 * opaque on-chain `InvalidBinStep` / `InvalidFee` failure after the user has
 * already signed.
 *
 * Mirrors the `require!` guards at the top of `initialize_pool`:
 *  - `bin_step_bps > 0`            (CloudsError::InvalidBinStep)
 *  - `swap_fee_bps <= 1000`        (CloudsError::InvalidFee)
 *  - `protocol_fee_bps <= 5000`    (CloudsError::InvalidFee)
 *
 * @throws Error with a human-readable message on any out-of-range value.
 */
export function validateRainParams(params: RainParams): void {
  const { binStep, swapFeeBps, protocolFeeBps } = params;
  if (!Number.isInteger(binStep) || binStep <= 0 || binStep > 0xffff) {
    throw new Error(
      `Ponk Rain: bin step must be a positive u16 (got ${binStep})`,
    );
  }
  if (!Number.isInteger(swapFeeBps) || swapFeeBps < 0 || swapFeeBps > MAX_SWAP_FEE_BPS) {
    throw new Error(
      `Ponk Rain: swap fee must be 0..=${MAX_SWAP_FEE_BPS} bps (got ${swapFeeBps})`,
    );
  }
  if (
    !Number.isInteger(protocolFeeBps) ||
    protocolFeeBps < 0 ||
    protocolFeeBps > MAX_PROTOCOL_FEE_BPS
  ) {
    throw new Error(
      `Ponk Rain: protocol fee must be 0..=${MAX_PROTOCOL_FEE_BPS} bps of the swap fee (got ${protocolFeeBps})`,
    );
  }
  if (!Number.isInteger(params.activeBinId)) {
    throw new Error(
      `Ponk Rain: active bin id must be an integer (got ${params.activeBinId})`,
    );
  }
}

/**
 * Convenience re-export of {@link binIdForPrice} for the launch flow: turn a
 * human initial price (quote per base, decimal-adjusted) into the
 * `active_bin_id` the program stores. Returns null for a non-positive or
 * non-finite price/bin step.
 *
 * Because prices live on the discrete `(1 + binStep/10000)^binId` grid, the
 * exact price of the returned bin differs slightly from the input; surface the
 * resolved bin's price back to the creator so they confirm the real value.
 */
export function computeActiveBinId(
  price: number,
  binStep: number,
  decX: number,
  decY: number,
): number | null {
  return binIdForPrice(price, binStep, decX, decY);
}

/**
 * Build the Ponk Clouds `initialize_pool` instruction the pool creator signs.
 *
 * Account order is FROZEN to the program's `InitializePool` accounts struct:
 *
 *   [authority(signer,mut), pool(mut), mintX(ro), mintY(ro),
 *    vaultX(mut), vaultY(mut), system_program(ro)]
 *
 * Data = disc("initialize_pool")
 *      + bin_step_bps     (u16 LE)
 *      + swap_fee_bps     (u16 LE)
 *      + protocol_fee_bps (u16 LE)
 *      + active_bin_id    (i32 LE)
 *
 * The signer (`authority`) becomes `pool.authority` on-chain and is the only
 * key that can later change fees, pause, or claim protocol fees. The two vaults
 * are the pool PDA's ATAs (owner == pool) and MUST already exist; use
 * {@link createPoolIxs}, which prepends their idempotent creation and the CU
 * budget.
 *
 * Validates the config locally first (see {@link validateRainParams}).
 */
export function initializePoolIx(params: RainParams): TransactionInstruction {
  validateRainParams(params);
  const pool = poolPda(params.mintX, params.mintY, params.binStep);
  const vaultX = vaultPda(pool, params.mintX);
  const vaultY = vaultPda(pool, params.mintY);
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(params.authority, true, true),
      meta(pool, false, true),
      meta(params.mintX, false, false),
      meta(params.mintY, false, false),
      meta(vaultX, false, true),
      meta(vaultY, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: concatBytes([
      DISCRIMINATORS.initializePool,
      u16le(params.binStep),
      u16le(params.swapFeeBps),
      u16le(params.protocolFeeBps),
      i32le(params.activeBinId),
    ]),
  });
}

/**
 * The ComputeBudget `setComputeUnitLimit` instruction that leads a create-pool
 * transaction. The full create tx (two vault ATA creations + initialize_pool)
 * measures ~37-53k CU on live mainnet pairs, so {@link CLOUDS_CREATE_CU_LIMIT}
 * (80_000) gives comfortable headroom without overpaying priority fees, and
 * makes the CU accounting deterministic and wallet-independent.
 */
export function createPoolComputeBudgetIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({
    units: CLOUDS_CREATE_CU_LIMIT,
  });
}

/**
 * Create-idempotent ATA instruction (Associated Token Program data byte `1`),
 * so a missing token account is created and an existing one is a no-op rather
 * than a hard failure. Used to materialize the pool's two vaults (owner ==
 * pool PDA) ahead of `initialize_pool`.
 */
function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      meta(payer, true, true),
      meta(ata(owner, mint), false, true),
      meta(owner, false, false),
      meta(mint, false, false),
      meta(SystemProgram.programId, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: Buffer.from([1]),
  });
}

/**
 * The full ordered instruction list to create a Ponk Clouds pool, exactly as
 * the CLI and the dex-web create flow build it:
 *
 *   [ setComputeUnitLimit(80k),
 *     createAtaIdempotent(vaultX, owner = pool),
 *     createAtaIdempotent(vaultY, owner = pool),
 *     initialize_pool ]
 *
 * Use this (not the bare {@link initializePoolIx}) when assembling the
 * transaction the creator signs, so the vaults the program constrains on always
 * exist first and the CU limit is explicit.
 */
export function createPoolIxs(params: RainParams): TransactionInstruction[] {
  validateRainParams(params);
  const pool = poolPda(params.mintX, params.mintY, params.binStep);
  return [
    createPoolComputeBudgetIx(),
    createAtaIdempotentIx(params.authority, pool, params.mintX),
    createAtaIdempotentIx(params.authority, pool, params.mintY),
    initializePoolIx(params),
  ];
}

/**
 * Build the Ponk Clouds `init_pool_treasury` instruction. This creates the
 * per-pool treasury PDA (`[b"pool_treasury", pool]`) that the platform's cut OF
 * the swap fee accrues into, so the treasury has a home from the pool's very
 * first swap. It is protocol-level fee plumbing done WITHOUT a program upgrade:
 * the create flow can append it to the SAME transaction (or a quick follow-up)
 * where the creator is already the `authority` signer.
 *
 * No instruction args. Account order is FROZEN to the program's
 * `InitPoolTreasury` struct:
 *
 *   [authority(signer,mut), pool(ro), poolTreasury PDA(mut), system_program(ro)]
 *
 * The authority pays the PDA's rent and signs; the pool is read-only (the
 * treasury PDA is seeded from it); SystemProgram creates the account. The
 * authority MUST be the pool's recorded authority (the program enforces
 * `has_one = authority`).
 */
export function initPoolTreasuryIx(params: {
  authority: PublicKey;
  pool: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(params.authority, true, true),
      meta(params.pool, false, false),
      meta(poolTreasuryPda(params.pool), false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: concatBytes([DISCRIMINATORS.initPoolTreasury]),
  });
}

/**
 * Build the Ponk Clouds `initialize_bin_array` instruction: allocate the empty
 * 70-bin window whose start id is `startBin`.
 *
 * `startBin` MUST be aligned to the bin-array grid (a multiple of
 * BINS_PER_ARRAY); the program rejects a misaligned start with
 * `MisalignedBinArray`. Use {@link arrayStartForBin} (or
 * {@link seedActiveBinArrayIx}) to derive an aligned start from a bin id.
 *
 * Account order is FROZEN to the program's `InitializeBinArray` struct:
 *
 *   [payer(signer,mut), pool(ro), binArray PDA(mut), system_program(ro)]
 *
 * Data = disc("initialize_bin_array") + start_bin_id (i32 LE).
 *
 * NOTE: this is the Rain-launch variant, named distinctly from the LP-side
 * `initBinArrayIx` in `position.ts` (which is identical in wire format) so the
 * two modules can both be re-exported from the SDK barrel without a name
 * collision. Either may be used interchangeably; the program does not care who
 * pays for the window.
 */
export function initRainBinArrayIx(
  payer: PublicKey,
  pool: PublicKey,
  startBin: number,
): TransactionInstruction {
  if (!Number.isInteger(startBin)) {
    throw new Error(`Ponk Rain: bin array start must be an integer (got ${startBin})`);
  }
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(payer, true, true),
      meta(pool, false, false),
      meta(binArrayPda(pool, startBin), false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: concatBytes([DISCRIMINATORS.initBinArray, i32le(startBin)]),
  });
}

/**
 * Initialize the bin array that holds the new pool's ACTIVE bin, so the market
 * is immediately swappable/seedable without a separate setup step.
 *
 * Convenience over {@link initRainBinArrayIx}: derives the grid-aligned start
 * from `activeBinId` via {@link arrayStartForBin}, so the caller never has to
 * align it by hand. The payer is the launch authority by default.
 */
export function seedActiveBinArrayIx(params: {
  payer: PublicKey;
  pool: PublicKey;
  activeBinId: number;
}): TransactionInstruction {
  return initRainBinArrayIx(
    params.payer,
    params.pool,
    arrayStartForBin(params.activeBinId),
  );
}

/**
 * The high-level inputs for {@link createMarket}: a price-first launch config
 * that mirrors the Ponk Rain create UI (`base`/`quote` mints, a bin step, a base
 * swap-fee tier, the creator's protocol-fee cut, and a human initial price).
 *
 * `mintX` is the base token, `mintY` the quote; price is quote per base. The
 * order is NOT canonicalized and is part of the pool identity (see the module
 * doc). `decimalsX`/`decimalsY` are required to map the human price onto the bin
 * grid; pass the mints' real on-chain decimals (wSOL = 9, USDC = 6, ...).
 */
export interface CreateMarketParams {
  /** The launch authority: signs, pays, and becomes `pool.authority`. */
  authority: PublicKey;
  /** Base token mint (X side of the pool). */
  mintX: PublicKey;
  /** Quote token mint (Y side of the pool). */
  mintY: PublicKey;
  /** Base-token decimals, for mapping the human price to the bin grid. */
  decimalsX: number;
  /** Quote-token decimals, for mapping the human price to the bin grid. */
  decimalsY: number;
  /** Bin step in bps; part of the pool PDA seed. Must be > 0. */
  binStep: number;
  /** Base (swap) fee in bps the trader pays the pool. 0..=1000. */
  baseFeeBps: number;
  /** The creator's cut OF the swap fee, in bps. 0..=5000. */
  protocolFeeBps: number;
  /** Initial price, quote per base (e.g. USDC per SOL). Must be > 0. */
  initialPrice: number;
  /**
   * When true (the default), prepend `initialize_bin_array` for the active
   * bin's window so the market is swappable/seedable in the same transaction.
   * Set false to allocate it later (e.g. lazily on first deposit).
   */
  seedActiveBinArray?: boolean;
}

/**
 * The result of {@link createMarket}: the derived pool address plus the launch
 * instructions, split so the caller controls atomicity and signing. Nothing is
 * signed or sent; the caller owns key custody and decides how to pack the
 * instructions into transactions.
 */
export interface CreateMarketPlan {
  /** The pool PDA the market is created at. */
  pool: PublicKey;
  /** The pool's protocol-treasury PDA (where the platform fee accrues). */
  poolTreasury: PublicKey;
  /** The active bin id resolved from `initialPrice` on the bin grid. */
  activeBinId: number;
  /**
   * The pool-creation bundle: CU budget + the two pool-vault ATA creations +
   * `initialize_pool` (+ the active bin array's `initialize_bin_array` when
   * `seedActiveBinArray` is not disabled). Build the creator's first
   * transaction from these.
   */
  createIxs: TransactionInstruction[];
  /**
   * The treasury-init instruction. Kept SEPARATE so a treasury hiccup can never
   * undo or block the (more important) pool creation; the dex-web flow lands it
   * as a quick second signature after the pool confirms. Append it to the same
   * transaction only if you want strict atomicity.
   */
  treasuryIx: TransactionInstruction;
}

/**
 * Build everything needed to launch a new Ponk Clouds market from a price-first
 * config, deriving the active bin from the initial price.
 *
 * Steps performed:
 *  1. Validate the bin step and fee caps (throws locally on a bad config).
 *  2. Resolve `activeBinId` from `initialPrice` on the bin grid (throws if the
 *     price is non-positive / non-finite / out of representable range).
 *  3. Derive the pool and treasury PDAs.
 *  4. Assemble the create bundle (CU budget + vault ATAs + initialize_pool, plus
 *     the active bin array unless `seedActiveBinArray === false`) and the
 *     separate treasury-init instruction.
 *
 * Nothing is signed or sent. The caller decides how to pack and sign the
 * returned instructions; see {@link CreateMarketPlan} for the atomicity notes.
 *
 * @throws Error on an out-of-range fee/bin step or an unrepresentable price.
 */
export function createMarket(params: CreateMarketParams): CreateMarketPlan {
  const activeBinId = binIdForPrice(
    params.initialPrice,
    params.binStep,
    params.decimalsX,
    params.decimalsY,
  );
  if (activeBinId === null) {
    throw new Error(
      `Ponk Rain: could not resolve an active bin from price ${params.initialPrice} (must be a positive, finite price on a positive bin step)`,
    );
  }

  const rainParams: RainParams = {
    authority: params.authority,
    mintX: params.mintX,
    mintY: params.mintY,
    binStep: params.binStep,
    swapFeeBps: params.baseFeeBps,
    protocolFeeBps: params.protocolFeeBps,
    activeBinId,
  };
  // Validates bin step + fee caps; throws before any signature is requested.
  validateRainParams(rainParams);

  const pool = poolPda(params.mintX, params.mintY, params.binStep);
  const poolTreasury = poolTreasuryPda(pool);

  const createIxs = createPoolIxs(rainParams);
  if (params.seedActiveBinArray !== false) {
    createIxs.push(
      seedActiveBinArrayIx({ payer: params.authority, pool, activeBinId }),
    );
  }

  return {
    pool,
    poolTreasury,
    activeBinId,
    createIxs,
    treasuryIx: initPoolTreasuryIx({ authority: params.authority, pool }),
  };
}
