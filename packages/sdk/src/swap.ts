/**
 * Ponk Clouds swap: build the on-chain `swap` transaction and quote it
 * off-chain.
 *
 * Two halves live here:
 *
 *  1. Transaction building ({@link buildSwapIx} / {@link buildSwapIxs} /
 *     {@link swapStartBins}). The account order is FROZEN to the program's
 *     `Swap` accounts struct and the dex-web builder, byte-for-byte:
 *       [user, pool, primaryBinArray, vaultX, vaultY, userX, userY,
 *        tokenProgram]
 *     followed by up to {@link MAX_SWAP_BIN_ARRAYS}-1 ADDITIONAL writable
 *     BinArray accounts (the contiguous neighbours in the direction of
 *     travel). `data = disc("swap") + amount_in(u64 LE) + min_out(u64 LE) +
 *     x_for_y(u8)`. The 1..{@link MAX_SWAP_BIN_ARRAYS} array-count bound is
 *     enforced locally so a bad call fails here, not on-chain.
 *
 *  2. Off-chain quoting ({@link quoteSwap} / {@link minOutForSlippage}). The
 *     pool and its bin arrays are read from chain, the bins in the direction
 *     of travel are assembled into the same flat, contiguous, ascending-sorted
 *     book the program builds, and {@link swapAcrossBins} (the bit-for-bit port
 *     of `clouds_math::swap_across_bins`) is run to produce an exact
 *     {@link SwapQuote}. The quote drives an honest {@link minOutForSlippage}.
 *
 * Direction convention (matches the program and `clouds-math::router`):
 * `xForY = true` sells X for Y and walks the price DOWN into LOWER bins;
 * `xForY = false` sells Y for X and walks UP into HIGHER bins. The active
 * bin's array is always the named primary account.
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  PONK_CLOUDS_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  BINS_PER_ARRAY,
  MAX_SWAP_BIN_ARRAYS,
  CLOUDS_SWAP_CU_LIMIT,
  DISCRIMINATORS,
  BPS_DENOM,
} from "./constants";
import { concatBytes, u64le } from "./codec";
import {
  arrayStartForBin,
  ata,
  binArrayPda,
  poolPda,
  vaultPda,
} from "./pda";
import { decodeBinArray, fetchPool } from "./pool";
import { swapAcrossBins, type MutBin } from "./math/swap";
import type { SwapParams, SwapQuote } from "./types";

/** Build an `AccountMeta` (matches web3.js's plain object shape). */
function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean) {
  return { pubkey, isSigner, isWritable };
}

/**
 * The contiguous BinArray `start_bin_id`s a swap touches, in the order the
 * program walks them.
 *
 * Index 0 is always the active bin's array (the named primary account). The
 * rest extend in the direction of travel: `xForY` consumes Y DOWNWARD into
 * lower bins, so neighbours are subtracted; `!xForY` consumes X UPWARD into
 * higher bins, so neighbours are added. The program sorts internally and
 * validates contiguity, alignment, same-pool, and direction, so emitting the
 * starts in travel order keeps the remaining-account list contiguous and
 * intuitive.
 *
 * @param activeBinId  The pool's current active bin id.
 * @param count  Total number of arrays to span (clamped to >= 1).
 * @param xForY  Swap direction (true = sell X for Y, walk down).
 * @returns The array start bin ids, `[0]` = active array.
 */
export function swapStartBins(
  activeBinId: number,
  count: number,
  xForY: boolean,
): number[] {
  const primary = arrayStartForBin(activeBinId);
  const out = [primary];
  for (let i = 1; i < Math.max(1, count); i += 1) {
    out.push(xForY ? primary - i * BINS_PER_ARRAY : primary + i * BINS_PER_ARRAY);
  }
  return out;
}

/**
 * Build the Ponk Clouds `swap` instruction.
 *
 * The account order is FROZEN and byte-matches the program's `Swap` accounts
 * struct (`programs/ponk-clouds/src/lib.rs`) and the dex-web builder:
 *   [user(signer,mut), pool(mut), primaryBinArray(mut), vaultX(mut),
 *    vaultY(mut), userX(mut), userY(mut), tokenProgram(ro)]
 * then up to {@link MAX_SWAP_BIN_ARRAYS}-1 ADDITIONAL BinArray pubkeys appended
 * as writable remaining accounts. `startBins[0]` is the active bin's array (the
 * named primary account); the remaining entries are the contiguous neighbour
 * arrays in travel order. The program re-derives each array's canonical PDA,
 * checks owner/pool/alignment/contiguity/direction, and scatters reserves back.
 *
 * `data = disc("swap") + amount_in(u64 LE) + min_out(u64 LE) + x_for_y(u8)`.
 *
 * @throws Error if no arrays are supplied or more than {@link MAX_SWAP_BIN_ARRAYS}.
 */
export function buildSwapIx(params: SwapParams): TransactionInstruction {
  if (params.startBins.length === 0) {
    throw new Error("buildSwapIx: at least the active bin array is required");
  }
  if (params.startBins.length > MAX_SWAP_BIN_ARRAYS) {
    throw new Error(
      `buildSwapIx: at most ${MAX_SWAP_BIN_ARRAYS} bin arrays per swap (got ${params.startBins.length})`,
    );
  }
  const pool = poolPda(params.mintX, params.mintY, params.binStep);
  // The length guard above proves index 0 exists; read it explicitly (the
  // destructure would widen to `number | undefined` under
  // noUncheckedIndexedAccess) and slice off the contiguous neighbour starts.
  const primaryStart = params.startBins[0]!;
  const extraStarts = params.startBins.slice(1);
  const keys = [
    meta(params.user, true, true),
    meta(pool, false, true),
    meta(binArrayPda(pool, primaryStart), false, true),
    meta(vaultPda(pool, params.mintX), false, true),
    meta(vaultPda(pool, params.mintY), false, true),
    meta(ata(params.user, params.mintX), false, true),
    meta(ata(params.user, params.mintY), false, true),
    meta(TOKEN_PROGRAM_ID, false, false),
    // Remaining accounts: the extra contiguous BinArrays, writable because the
    // program mutates their reserves and writes them back.
    ...extraStarts.map((s) => meta(binArrayPda(pool, s), false, true)),
  ];
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys,
    data: concatBytes([
      DISCRIMINATORS.swap,
      u64le(params.amountIn),
      u64le(params.minOut),
      Uint8Array.from([params.xForY ? 1 : 0]),
    ]),
  });
}

/**
 * The ComputeBudget `setComputeUnitLimit` instruction that must lead a Clouds
 * swap transaction.
 *
 * {@link CLOUDS_SWAP_CU_LIMIT} sits above the measured worst case for a
 * full multi-array swap, giving headroom without overpaying priority fees, and
 * makes the tx's CU accounting deterministic (a wallet cannot inject a
 * differing limit).
 */
export function swapComputeBudgetIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: CLOUDS_SWAP_CU_LIMIT });
}

/**
 * The full ordered instruction list for a Clouds swap: the CU-limit
 * instruction ({@link swapComputeBudgetIx}) prepended ahead of the
 * {@link buildSwapIx} swap. Use this (not the bare swap ix) when assembling the
 * transaction a wallet signs, so the tx always carries enough CU headroom.
 */
export function buildSwapIxs(params: SwapParams): TransactionInstruction[] {
  return [swapComputeBudgetIx(), buildSwapIx(params)];
}

/**
 * Floor the quoted output by a slippage tolerance to get a `min_out`.
 *
 * `floor(quotedOut * (10000 - slippageBps) / 10000)`. A `slippageBps` outside
 * `[0, 10000]` is clamped to that range so the result is always a sane,
 * non-negative bound (0 bps = exact quote, 10000 bps = accept any output).
 *
 * @param quotedOut  The off-chain quoted output in base units.
 * @param slippageBps  Tolerance in basis points.
 */
export function minOutForSlippage(quotedOut: bigint, slippageBps: number): bigint {
  const clamped = slippageBps < 0 ? 0 : slippageBps > 10_000 ? 10_000 : slippageBps;
  return (quotedOut * (BPS_DENOM - BigInt(clamped))) / BPS_DENOM;
}

/**
 * Quote a swap off-chain so the result equals what the program will return.
 *
 * Reads the pool and the contiguous bin arrays the swap can walk (the active
 * bin's array plus up to `maxBinArrays-1` neighbours in the direction of
 * travel), assembles the same flat, ascending-sorted, contiguous book the
 * program builds, prices each bin with the exact Q64.64 {@link binPriceQ64},
 * and runs {@link swapAcrossBins} (the bit-for-bit port of
 * `clouds_math::swap_across_bins`). The treasury cut is included only when the
 * pool has a treasury config; here the off-chain quote uses the pool's own
 * swap/protocol fees and a zero treasury fee, matching a swap that does not
 * pass the treasury-config remaining account. The treasury cut never changes
 * `amount_out` (it is withheld from LP reserves, not the trader), so the quoted
 * output and `min_out` are exact regardless.
 *
 * `maxBinArrays` defaults to {@link MAX_SWAP_BIN_ARRAYS} and is clamped into
 * `[1, MAX_SWAP_BIN_ARRAYS]`, matching the on-chain account-count cap so a
 * quote never spans more arrays than a swap could load.
 *
 * @throws Error if the pool does not exist at this RPC.
 */
export async function quoteSwap(
  conn: Connection,
  args: {
    mintX: PublicKey;
    mintY: PublicKey;
    binStep: number;
    amountIn: bigint;
    xForY: boolean;
    maxBinArrays?: number;
  },
): Promise<SwapQuote> {
  const pool = await fetchPool(conn, args.mintX, args.mintY, args.binStep);
  if (!pool) throw new Error("Ponk Clouds pool not found at this RPC");

  const requested = args.maxBinArrays ?? MAX_SWAP_BIN_ARRAYS;
  const arrayCount = Math.min(Math.max(1, requested), MAX_SWAP_BIN_ARRAYS);

  // The distinct, contiguous array starts the swap may walk, in travel order.
  const starts = swapStartBins(pool.activeBinId, arrayCount, args.xForY);
  const arrayAddrs = starts.map((s) => binArrayPda(pool.address, s));
  const infos = await conn.getMultipleAccountsInfo(arrayAddrs);

  // Decode each loaded array's slot reserves keyed by start. A missing array
  // (never initialized) contributes empty bins, exactly like an on-chain swap
  // that loads it: the book runs dry there and the unfilled input is returned.
  const slotsByStart = new Map<number, { reserveX: bigint; reserveY: bigint }[]>();
  starts.forEach((start, i) => {
    const info = infos[i];
    if (info) {
      const decoded = decodeBinArray(info.data);
      slotsByStart.set(
        start,
        decoded.slots.map((s) => ({ reserveX: s.reserveX, reserveY: s.reserveY })),
      );
    } else {
      slotsByStart.set(start, null as unknown as { reserveX: bigint; reserveY: bigint }[]);
    }
  });

  // Build the flat book the program builds: every bin of every loaded array,
  // sorted ascending by bin id and contiguous around the active bin. Empty
  // arrays still occupy their window (zero reserves) so contiguity holds.
  const sortedStarts = [...starts].sort((a, b) => a - b);
  const bins: MutBin[] = [];
  for (const start of sortedStarts) {
    const slots = slotsByStart.get(start) ?? null;
    for (let slot = 0; slot < BINS_PER_ARRAY; slot += 1) {
      const s = slots ? slots[slot] : undefined;
      bins.push({
        binId: start + slot,
        reserveX: s ? s.reserveX : 0n,
        reserveY: s ? s.reserveY : 0n,
      });
    }
  }

  const activeIndex = bins.findIndex((b) => b.binId === pool.activeBinId);
  if (activeIndex < 0) {
    // Unreachable: swapStartBins always includes the active bin's array, which
    // we lay down above. Guard anyway so a future refactor fails loudly.
    throw new Error("quoteSwap: active bin not present in the assembled book");
  }

  const result = swapAcrossBins(
    bins,
    activeIndex,
    pool.binStepBps,
    pool.swapFeeBps,
    pool.protocolFeeBps,
    // No treasury config is loaded in an off-chain quote, so the treasury cut
    // is zero here; it never affects amount_out.
    0,
    args.amountIn,
    args.xForY,
  );

  // How many of the loaded arrays the walk actually touched, by the span of
  // bin ids crossed (active bin id -> end bin id). This is informational; the
  // on-chain swap still passes the full contiguous set it was given.
  const lo = Math.min(pool.activeBinId, result.endBinId);
  const hi = Math.max(pool.activeBinId, result.endBinId);
  const touched = new Set<number>();
  for (let b = lo; b <= hi; b += 1) touched.add(arrayStartForBin(b));
  const binArraysTouched = touched.size;

  // `treasuryFee` is 0 here (no treasury config is loaded in an off-chain
  // quote); it is carried straight through from the router result so the field
  // stays honest if that ever changes. It never affects `amountOut`.
  return {
    amountIn: args.amountIn,
    amountInConsumed: result.amountInConsumed,
    amountInRemaining: result.amountInRemaining,
    amountOut: result.amountOut,
    fee: result.fee,
    protocolFee: result.protocolFee,
    treasuryFee: result.treasuryFee,
    endBinId: result.endBinId,
    binArraysTouched,
  };
}
