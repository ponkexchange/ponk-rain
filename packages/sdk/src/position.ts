/**
 * Open, fund, and close LP positions in a Ponk Clouds pool.
 *
 * This module builds every liquidity-side instruction a wallet signs, with each
 * account order FROZEN to the matching on-chain accounts struct in
 * `ponk-clouds/programs/ponk-clouds/src/lib.rs`:
 *
 *  - {@link initBinArrayIx}   -> `InitializeBinArray`   (allocate a 70-bin window)
 *  - {@link initPositionIx}   -> `InitializePosition`   (open an empty range)
 *  - {@link addLiquidityIx}   -> `ModifyLiquidity`      (deposit into one bin)
 *  - {@link removeLiquidityIx}-> `ModifyLiquidity`      (burn shares from one bin)
 *  - {@link closePositionIx}  -> `ClosePosition`        (refund rent when empty)
 *
 * The wire format of every builder is ported byte-for-byte from
 * `dex-web/lib/ponkclouds.ts`, including the wSOL helpers
 * ({@link createAtaIdempotentIx}, {@link wrapSolIxs}, {@link closeWsolIx}) and the
 * native-SOL `max` helper ({@link maxSpendableBaseUnits}), so a transaction this
 * SDK builds is indistinguishable from the one the dex-web client builds.
 *
 * It also reads state: {@link decodePosition} decodes a `Position` account at its
 * exact byte offsets, {@link readPositions} discovers an owner's positions in a
 * pool via `getProgramAccounts` (memcmp owner@8, pool@40), and
 * {@link loadDepositContext} reports whether the target bin array and position
 * already exist so callers can prepend exactly the init instructions they need.
 * {@link openPositionIxs} assembles the full single-bin add-liquidity bundle.
 *
 * Reserves and shares are `u128` on-chain and surface as `bigint`. Nothing is
 * fabricated: an empty bin reads as zero reserves/shares, never a guess.
 *
 * On-chain `Position` layout (8-byte Anchor discriminator + fields):
 *   owner          Pubkey  @ 8
 *   pool           Pubkey  @ 40
 *   lower_bin_id   i32     @ 72
 *   upper_bin_id   i32     @ 76
 *   shares vec-len u32     @ 80
 *   shares[i]      u128    @ 84 + i*16   (length = upper - lower + 1)
 *   bump           u8      @ 84 + len*16
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DISCRIMINATORS,
  NATIVE_MINT,
  PONK_CLOUDS_PROGRAM_ID,
  SOL_MAX_RESERVE_LAMPORTS,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { concatBytes, i32le, readU128LE, u64le, u128le } from "./codec.js";
import {
  arrayStartForBin,
  ata,
  binArrayPda,
  poolPda,
  positionPda,
  vaultPda,
} from "./pda.js";
import { decodeBinSlot, decodePool } from "./pool.js";
import type { BinSlot, CloudsPool, CloudsPosition, PoolInfo } from "./types.js";

/** Build an Anchor-style account meta. */
function meta(
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner, isWritable };
}

/** SPL Token instruction tag for `SyncNative` (wraps lamports into wSOL). */
const TOKEN_IX_SYNC_NATIVE = 17;
/** SPL Token instruction tag for `CloseAccount` (unwraps a wSOL ATA). */
const TOKEN_IX_CLOSE_ACCOUNT = 9;
/** Associated Token Account instruction tag for `CreateIdempotent`. */
const ATA_IX_CREATE_IDEMPOTENT = 1;

// ---------------------------------------------------------------------------
// Token-account helpers (ATA creation, wSOL wrap/unwrap, native max).
// ---------------------------------------------------------------------------

/**
 * Build a create-idempotent ATA instruction (Associated Token Program data byte
 * `1`), so a missing token account is created and an existing one is a no-op
 * rather than a hard failure.
 *
 * Account order matches the Associated Token Account program's
 * `CreateIdempotent`: [payer(signer,mut), ata(mut), owner(ro), mint(ro),
 * system_program(ro), token_program(ro)].
 *
 * @param payer  Funds the new account's rent and signs.
 * @param owner  The wallet that will own the ATA.
 * @param mint   The token mint the ATA holds.
 */
export function createAtaIdempotentIx(
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
    data: Buffer.from([ATA_IX_CREATE_IDEMPOTENT]),
  });
}

/**
 * Wrap native SOL into the owner's wSOL ATA: create it (idempotent), transfer
 * `lamports` into it, then `SyncNative` so the wrapped balance is counted.
 *
 * Returned as an ordered list so callers can keep it in the SAME transaction as
 * the deposit it funds (so the wrap and its use land together or not at all).
 *
 * @param owner    The wallet wrapping SOL; pays and signs the transfer.
 * @param lamports The amount of native SOL to wrap, in lamports.
 */
export function wrapSolIxs(
  owner: PublicKey,
  lamports: bigint,
): TransactionInstruction[] {
  const wsol = ata(owner, NATIVE_MINT);
  return [
    createAtaIdempotentIx(owner, owner, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: wsol,
      lamports,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [meta(wsol, false, true)],
      data: Buffer.from([TOKEN_IX_SYNC_NATIVE]),
    }),
  ];
}

/**
 * Close the owner's wSOL ATA (SPL Token `CloseAccount`), returning any leftover
 * wrapped SOL plus the account's rent to the owner. Run after a deposit/swap so
 * no stray wSOL is stranded.
 *
 * Account order matches `CloseAccount`: [account(mut), destination(mut),
 * owner(signer)].
 *
 * @param owner  The wallet that owns the wSOL ATA and receives the refund.
 */
export function closeWsolIx(owner: PublicKey): TransactionInstruction {
  const wsol = ata(owner, NATIVE_MINT);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      meta(wsol, false, true),
      meta(owner, false, true),
      meta(owner, true, false),
    ],
    data: Buffer.from([TOKEN_IX_CLOSE_ACCOUNT]),
  });
}

/**
 * The spendable base units for a `max`/percentage on an input: the full balance,
 * minus {@link SOL_MAX_RESERVE_LAMPORTS} when `mint` is native (wrapped) SOL.
 *
 * Spending the literal full SOL balance leaves nothing for the network fee and
 * the wrap account's rent, so the wrap fails; reserving a small buffer avoids
 * that. Non-SOL mints return the full balance unchanged.
 *
 * @param amountBaseUnits  The full balance, in base units.
 * @param mint  The input mint; the reserve only applies when it is wSOL.
 */
export function maxSpendableBaseUnits(
  amountBaseUnits: bigint,
  mint: PublicKey,
): bigint {
  if (mint.equals(NATIVE_MINT)) {
    return amountBaseUnits > SOL_MAX_RESERVE_LAMPORTS
      ? amountBaseUnits - SOL_MAX_RESERVE_LAMPORTS
      : 0n;
  }
  return amountBaseUnits;
}

// ---------------------------------------------------------------------------
// Instruction builders (account orders frozen to the program's structs).
// ---------------------------------------------------------------------------

/**
 * Build the Ponk Clouds `initialize_bin_array` instruction: allocate the empty
 * 70-bin window whose start id is `startBin`.
 *
 * `startBin` MUST be aligned to the bin-array grid (a multiple of
 * `BINS_PER_ARRAY`); the program rejects a misaligned start with
 * `MisalignedBinArray`. Use {@link arrayStartForBin} to derive an aligned start
 * from an arbitrary bin id.
 *
 * Account order is FROZEN to the program's `InitializeBinArray` struct:
 *   [payer(signer,mut), pool(ro), binArray PDA(mut), system_program(ro)].
 *
 * Data = disc("initialize_bin_array") + start_bin_id (i32 LE).
 *
 * @param payer    Funds the window's rent and signs.
 * @param pool     The pool PDA the window belongs to.
 * @param startBin The grid-aligned first bin id of the window.
 */
export function initBinArrayIx(
  payer: PublicKey,
  pool: PublicKey,
  startBin: number,
): TransactionInstruction {
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
 * Build the Ponk Clouds `initialize_position` instruction: open an empty
 * position over the inclusive bin range `[lower, upper]`.
 *
 * The position PDA is keyed by `(pool, owner, lower)`, so `lower` is part of its
 * identity; a wallet has at most one position per `(pool, lower)`. The program
 * requires `upper >= lower` and `upper - lower + 1 <= BINS_PER_ARRAY` (70).
 *
 * Account order is FROZEN to the program's `InitializePosition` struct:
 *   [owner(signer,mut), pool(ro), position PDA(mut), system_program(ro)].
 *
 * Data = disc("initialize_position") + lower_bin_id (i32 LE) + upper_bin_id
 * (i32 LE).
 *
 * @param owner  The position owner; pays rent and signs.
 * @param pool   The pool PDA the position belongs to.
 * @param lower  Inclusive lower bin id (part of the PDA seed).
 * @param upper  Inclusive upper bin id.
 */
export function initPositionIx(
  owner: PublicKey,
  pool: PublicKey,
  lower: number,
  upper: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(owner, true, true),
      meta(pool, false, false),
      meta(positionPda(pool, owner, lower), false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: concatBytes([
      DISCRIMINATORS.initPosition,
      i32le(lower),
      i32le(upper),
    ]),
  });
}

/**
 * Build the Ponk Clouds `add_liquidity` instruction: deposit `amountX`/`amountY`
 * into a single bin (`binId`) of an existing position, minting shares.
 *
 * The program pulls ONLY the matched reserves (`used_x`/`used_y`) into the
 * vaults and refunds any off-ratio surplus to the depositor; the active bin is
 * the only bin that can hold both reserves, so off-active bins take a
 * single-sided deposit in full. The bin array (containing `startBin`) and the
 * position (keyed by `lower`) must already exist; use {@link openPositionIxs} to
 * prepend their init instructions when needed.
 *
 * Account order is FROZEN to the program's `ModifyLiquidity` struct:
 *   [owner(signer,mut), pool(ro), binArray(mut), position(mut), vaultX(mut),
 *    vaultY(mut), userTokenX(mut), userTokenY(mut), token_program(ro)].
 *
 * Data = disc("add_liquidity") + bin_id (i32 LE) + amount_x (u64 LE) + amount_y
 * (u64 LE).
 */
export function addLiquidityIx(args: {
  owner: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  binStep: number;
  startBin: number;
  lower: number;
  binId: number;
  amountX: bigint;
  amountY: bigint;
}): TransactionInstruction {
  const pool = poolPda(args.mintX, args.mintY, args.binStep);
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(args.owner, true, true),
      meta(pool, false, false),
      meta(binArrayPda(pool, args.startBin), false, true),
      meta(positionPda(pool, args.owner, args.lower), false, true),
      meta(vaultPda(pool, args.mintX), false, true),
      meta(vaultPda(pool, args.mintY), false, true),
      meta(ata(args.owner, args.mintX), false, true),
      meta(ata(args.owner, args.mintY), false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: concatBytes([
      DISCRIMINATORS.addLiquidity,
      i32le(args.binId),
      u64le(args.amountX),
      u64le(args.amountY),
    ]),
  });
}

/**
 * Build the Ponk Clouds `remove_liquidity` instruction: burn `shares` from a
 * single bin (`binId`) of a position, returning the proportional reserves
 * (including accrued swap fees) from the pool vaults to the owner.
 *
 * Account order is FROZEN to the program's `ModifyLiquidity` struct (identical
 * to {@link addLiquidityIx}):
 *   [owner(signer,mut), pool(ro), binArray(mut), position(mut), vaultX(mut),
 *    vaultY(mut), userTokenX(mut), userTokenY(mut), token_program(ro)].
 *
 * Data = disc("remove_liquidity") + bin_id (i32 LE) + shares (u128 LE). `shares`
 * is a `u128` because per-bin share balances are `u128` on-chain.
 */
export function removeLiquidityIx(args: {
  owner: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  binStep: number;
  startBin: number;
  lower: number;
  binId: number;
  shares: bigint;
}): TransactionInstruction {
  const pool = poolPda(args.mintX, args.mintY, args.binStep);
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(args.owner, true, true),
      meta(pool, false, false),
      meta(binArrayPda(pool, args.startBin), false, true),
      meta(positionPda(pool, args.owner, args.lower), false, true),
      meta(vaultPda(pool, args.mintX), false, true),
      meta(vaultPda(pool, args.mintY), false, true),
      meta(ata(args.owner, args.mintX), false, true),
      meta(ata(args.owner, args.mintY), false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: concatBytes([
      DISCRIMINATORS.removeLiquidity,
      i32le(args.binId),
      u128le(args.shares),
    ]),
  });
}

/**
 * Build the Ponk Clouds `close_position` instruction: close a fully-withdrawn
 * position and refund its rent to the owner. The program reverts with
 * `PositionNotEmpty` if any bin still holds shares.
 *
 * Account order is FROZEN to the program's `ClosePosition` struct:
 *   [owner(signer,mut), position PDA(mut, close = owner)].
 *
 * Data = disc("close_position"). `lower` is the position's lower bin id (its PDA
 * seed), used to re-derive the address.
 *
 * @param owner  The position owner; signs and receives the rent refund.
 * @param pool   The pool PDA the position belongs to.
 * @param lower  The position's lower (inclusive) bin id.
 */
export function closePositionIx(
  owner: PublicKey,
  pool: PublicKey,
  lower: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(owner, true, true),
      meta(positionPda(pool, owner, lower), false, true),
    ],
    data: concatBytes([DISCRIMINATORS.closePosition]),
  });
}

// ---------------------------------------------------------------------------
// Position decoding + discovery.
// ---------------------------------------------------------------------------

/**
 * Decode a `Position` account at its exact byte offsets into the typed
 * {@link CloudsPosition} shape. The caller supplies the position PDA `address`
 * since it is not stored inside the account data.
 *
 * Layout: 8 disc + 32 owner + 32 pool + 4 lower + 4 upper + 4 vec-len, then
 * `len` u128 share entries (one per bin in `[lower, upper]`), then a bump u8.
 */
export function decodePosition(
  address: PublicKey,
  data: Uint8Array,
): CloudsPosition {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const owner = new PublicKey(data.subarray(8, 40));
  const pool = new PublicKey(data.subarray(40, 72));
  const lowerBinId = dv.getInt32(72, true);
  const upperBinId = dv.getInt32(76, true);
  const len = dv.getUint32(80, true);
  const shares: bigint[] = [];
  for (let i = 0; i < len; i += 1) {
    shares.push(readU128LE(data, 84 + i * 16));
  }
  return {
    address: address.toBase58(),
    owner,
    pool,
    lowerBinId,
    upperBinId,
    shares,
  };
}

/**
 * Discover all of `owner`'s positions in the pool for `info`, via
 * `getProgramAccounts` with `memcmp` filters on owner@8 and pool@40 (the two
 * `Pubkey` fields at the head of a `Position` account).
 *
 * Positions whose every bin holds zero shares are dropped (they are spent but
 * not yet closed), and the survivors are sorted by their lower bin id so the
 * caller sees them in ascending price order.
 */
export async function readPositions(
  conn: Connection,
  info: PoolInfo,
  owner: PublicKey,
): Promise<CloudsPosition[]> {
  const pool = poolPda(
    new PublicKey(info.mintX),
    new PublicKey(info.mintY),
    info.binStep,
  );
  const accts = await conn.getProgramAccounts(PONK_CLOUDS_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 8, bytes: owner.toBase58() } },
      { memcmp: { offset: 40, bytes: pool.toBase58() } },
    ],
  });
  return accts
    .map((a) => decodePosition(a.pubkey, a.account.data))
    .filter((p) => p.shares.some((s) => s > 0n))
    .sort((a, b) => a.lowerBinId - b.lowerBinId);
}

// ---------------------------------------------------------------------------
// Deposit context + full single-bin add bundle.
// ---------------------------------------------------------------------------

/**
 * Read the pool, the target bin's slot, and whether the bin array and the
 * single-bin position already exist, so a caller knows exactly which init
 * instructions to prepend before an `add_liquidity`.
 *
 * `binId` is treated as a single-bin position: the position PDA is keyed by
 * `lower === binId`, and `startBin` is the grid-aligned start of the array that
 * holds it. When the bin array does not yet exist its slot reads as all zeros
 * (an honest empty bin), so a first deposit seeds it.
 *
 * @throws Error when the pool account is missing at this RPC.
 */
export async function loadDepositContext(
  conn: Connection,
  mintX: PublicKey,
  mintY: PublicKey,
  binStep: number,
  owner: PublicKey,
  binId: number,
): Promise<{
  pool: CloudsPool;
  slot: BinSlot;
  startBin: number;
  binArrayExists: boolean;
  positionExists: boolean;
}> {
  const poolKey = poolPda(mintX, mintY, binStep);
  const startBin = arrayStartForBin(binId);
  const binArray = binArrayPda(poolKey, startBin);
  // The position PDA mirrors a single-bin range: lower === binId.
  const position = positionPda(poolKey, owner, binId);

  const [poolAcc, baAcc, posAcc] = await conn.getMultipleAccountsInfo([
    poolKey,
    binArray,
    position,
  ]);
  if (!poolAcc) {
    throw new Error("Ponk Clouds pool not found at this RPC");
  }
  // Decode the pool from the bytes the batched fetch already returned, using
  // pool.ts's single-source decoder, so no second round-trip is made.
  const pool = decodePool(poolKey, poolAcc.data);
  const slot = baAcc
    ? decodeBinSlot(baAcc.data, startBin, binId)
    : { reserveX: 0n, reserveY: 0n, totalShares: 0n };
  return {
    pool,
    slot,
    startBin,
    binArrayExists: !!baAcc,
    positionExists: !!posAcc,
  };
}

/**
 * Assemble the full ordered instruction bundle to add liquidity to ONE bin,
 * prepending exactly the init instructions the deposit needs:
 *
 *   [ initialize_bin_array? , initialize_position? , add_liquidity ]
 *
 * The bin array's window (containing `binId`) is initialized first when
 * `binArrayExists` is false, then the single-bin position (keyed by
 * `lower === binId`) when `positionExists` is false, then the deposit itself.
 * The position is opened over the single bin `[binId, binId]`, matching the
 * `lower === binId` PDA derivation {@link loadDepositContext} uses.
 *
 * Pass the existence flags straight from {@link loadDepositContext}. The caller
 * owns key custody and packs/sends the result; nothing here is signed.
 */
export function openPositionIxs(ctx: {
  owner: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  binStep: number;
  lower: number;
  binId: number;
  amountX: bigint;
  amountY: bigint;
  binArrayExists: boolean;
  positionExists: boolean;
}): TransactionInstruction[] {
  const pool = poolPda(ctx.mintX, ctx.mintY, ctx.binStep);
  const startBin = arrayStartForBin(ctx.binId);
  const ixs: TransactionInstruction[] = [];
  if (!ctx.binArrayExists) {
    ixs.push(initBinArrayIx(ctx.owner, pool, startBin));
  }
  if (!ctx.positionExists) {
    // Open the position over the single bin [lower, lower]. The `lower` seed
    // must match the `add_liquidity` position PDA (keyed by `lower`).
    ixs.push(initPositionIx(ctx.owner, pool, ctx.lower, ctx.lower));
  }
  ixs.push(
    addLiquidityIx({
      owner: ctx.owner,
      mintX: ctx.mintX,
      mintY: ctx.mintY,
      binStep: ctx.binStep,
      startBin,
      lower: ctx.lower,
      binId: ctx.binId,
      amountX: ctx.amountX,
      amountY: ctx.amountY,
    }),
  );
  return ixs;
}
