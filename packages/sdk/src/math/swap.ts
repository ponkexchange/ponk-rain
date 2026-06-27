/**
 * Pure swap math, ported bit-for-bit from `clouds-math/src/swap.rs` and
 * `router.rs`.
 *
 * Within one bin the price is fixed at `priceQ64` (token Y per X), so X and Y
 * trade at that rate with zero in-bin slippage. The swap fee is taken off the
 * gross input first (so LPs earn on volume), then the net converts at the bin
 * price; output floors so the pool keeps the dust. {@link swapWithinBin} is
 * the single-bin primitive (with the partial-fill ceil gross-up that never
 * under-charges); {@link swapAcrossBins} is the cross-bin driver that walks
 * the book in the direction of travel, applies the joint protocol+treasury
 * fee clamp, and is bounded by MAX_BINS_PER_SWAP.
 *
 * This is what powers an off-chain quote that equals the on-chain result, so
 * a caller can compute an honest minOut. All bigint, deterministic.
 */

import { Q64, BPS_DENOM, MAX_BINS_PER_SWAP } from "../constants";
import { binPriceQ64 } from "./price";

/**
 * Tagged failure mode, mirroring the Rust `SwapError` enum order/meaning.
 * Thrown as the `.message` of a plain Error by {@link swapWithinBin} and
 * {@link swapAcrossBins}.
 */
export type SwapMathError = "InvalidPrice" | "InvalidFee" | "Overflow" | "MinLiquidity";

/** Reserves available in a single bin, plus its fixed Q64.64 price. */
export interface BinState {
  /** Q64.64 price, token Y per token X. */
  priceQ64: bigint;
  /** Base-unit reserve of token X currently in this bin. */
  reserveX: bigint;
  /** Base-unit reserve of token Y currently in this bin. */
  reserveY: bigint;
}

/** Result of filling (part of) a swap against one bin. */
export interface SwapFill {
  /** Gross input consumed from the trader (includes fee). */
  amountIn: bigint;
  /** Output sent to the trader. */
  amountOut: bigint;
  /** Fee taken from the input; stays in the bin for its LPs. */
  fee: bigint;
  /** True if this bin's output side is now exhausted (advance to the next bin). */
  binExhausted: boolean;
}

/** One bin's mutable reserves keyed by its id; {@link swapAcrossBins} mutates these in place. */
export interface MutBin {
  binId: number;
  reserveX: bigint;
  reserveY: bigint;
}

/** Aggregate outcome of a multi-bin swap. */
export interface SwapResult {
  amountInConsumed: bigint;
  amountOut: bigint;
  /** Total swap fee charged (LP share + protocol share + treasury share). */
  fee: bigint;
  /** Portion of `fee` taken as protocol revenue; not added to LP reserves. */
  protocolFee: bigint;
  /** Portion of `fee` taken as treasury (platform) revenue; not added to LP reserves. */
  treasuryFee: bigint;
  endBinId: number;
  /** Input the book could not fill (liquidity exhausted). Zero on a complete fill. */
  amountInRemaining: bigint;
}

const U128_MAX = (1n << 128n) - 1n;

/** Throw a `SwapMathError`-tagged Error (the message IS the variant name). */
function fail(kind: SwapMathError): never {
  throw new Error(kind);
}

/**
 * floor(a * b / c) for c > 0, 256-bit-safe over bigint. Throws `Overflow` if
 * the (u128-bounded) result would not fit, matching the `None` cases of the
 * Rust `mul_div_floor` which signal overflow of the final value.
 *
 * @example
 * mulDivFloor(10n, 3n, 4n); // => 7n   (30/4 = 7.5 -> 7)
 */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) fail("Overflow");
  const q = (a * b) / c;
  if (q > U128_MAX) fail("Overflow");
  return q;
}

/**
 * ceil(a * b / c) for c > 0, 256-bit-safe over bigint. Throws `Overflow` if
 * the result would not fit in u128.
 *
 * @example
 * mulDivCeil(10n, 3n, 4n); // => 8n   (30/4 = 7.5 -> 8)
 */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) fail("Overflow");
  const p = a * b;
  const floor = p / c;
  const ceil = p % c === 0n ? floor : floor + 1n;
  if (ceil > U128_MAX) fail("Overflow");
  return ceil;
}

/**
 * Swap `amountIn` of one token against a single bin.
 *
 * `xForY = true` means the trader sells X and receives Y (price walks down
 * through this and lower bins); `false` means sells Y for X.
 *
 * Fee is taken off the gross input first, then the net converts at the bin
 * price (floored, pool keeps the dust). If the bin cannot fully cover the
 * output it fills what it can, sets `binExhausted`, and returns the partial
 * fill so the caller loops to the next bin with `amountIn - fill.amountIn`.
 *
 * Throws an Error whose message is a {@link SwapMathError} on
 * InvalidPrice / InvalidFee / Overflow. Ported from `swap_within_bin`.
 *
 * @example
 * // 1% fee, par price: 10_000 X in -> fee 100, net 9_900 -> 9_900 Y out
 * swapWithinBin({ priceQ64: Q64, reserveX: 0n, reserveY: 1_000_000n }, 10_000n, 100, true);
 * // => { amountIn: 10_000n, amountOut: 9_900n, fee: 100n, binExhausted: false }
 */
export function swapWithinBin(
  bin: BinState,
  amountIn: bigint,
  feeBps: number,
  xForY: boolean,
): SwapFill {
  if (bin.priceQ64 === 0n) fail("InvalidPrice");
  if (BigInt(feeBps) >= BPS_DENOM) fail("InvalidFee");
  if (amountIn === 0n) {
    return { amountIn: 0n, amountOut: 0n, fee: 0n, binExhausted: false };
  }

  // Output reserve the trader draws from.
  const outReserve = xForY ? bin.reserveY : bin.reserveX;
  if (outReserve === 0n) {
    return { amountIn: 0n, amountOut: 0n, fee: 0n, binExhausted: true };
  }

  // Convert a NET input amount to output at this bin's price (floor).
  //   selling X for Y: out_y = net_x * price / Q64
  //   selling Y for X: out_x = net_y * Q64 / price
  const netToOut = (net: bigint): bigint =>
    xForY ? mulDivFloor(net, bin.priceQ64, Q64) : mulDivFloor(net, Q64, bin.priceQ64);

  // Try to fill with the full requested input first.
  const gross = amountIn;
  const feeFull = mulDivFloor(gross, BigInt(feeBps), BPS_DENOM);
  const netFull = gross - feeFull;
  const outFull = netToOut(netFull);

  if (outFull <= outReserve) {
    // Whole input fits in this bin.
    return {
      amountIn: gross,
      amountOut: outFull,
      fee: feeFull,
      binExhausted: outFull === outReserve,
    };
  }

  // Bin can only supply `outReserve`. Work backward to the NET input that
  // yields exactly outReserve, rounding the required net UP so the pool never
  // under-charges, then re-add the fee.
  //   selling X for Y: net_x = ceil(out_reserve * Q64 / price)
  //   selling Y for X: net_y = ceil(out_reserve * price / Q64)
  const netNeeded = xForY
    ? mulDivCeil(outReserve, Q64, bin.priceQ64)
    : mulDivCeil(outReserve, bin.priceQ64, Q64);

  // Gross up the net by the fee: gross = ceil(net * 10000 / (10000 - fee)).
  const grossNeeded = mulDivCeil(netNeeded, BPS_DENOM, BPS_DENOM - BigInt(feeBps));
  const feePart = grossNeeded - netNeeded;

  return {
    amountIn: grossNeeded,
    amountOut: outReserve,
    fee: feePart,
    binExhausted: true,
  };
}

/**
 * Drive a swap across `bins` (MUST be sorted ascending by `binId` and
 * contiguous around the active bin). `activeIndex` is the index of the active
 * bin. Mutates each bin's reserves in place as it fills.
 *
 * `xForY = true`: trader sells X, receives Y, price walks DOWN.
 * `xForY = false`: trader sells Y, receives X, price walks UP.
 *
 * `protocolFeeBps` and `treasuryFeeBps` are each a share, in bps OF THE SWAP
 * FEE, withheld from LP reserves and reported separately. They are clamped
 * JOINTLY so their sum cannot exceed 10_000 (protocol capped first, treasury
 * gets whatever bps remain), so `protocolFee + treasuryFee <= fee` always.
 *
 * Reaching MAX_BINS_PER_SWAP is a graceful stop: the unfilled input is
 * returned as `amountInRemaining`. Throws a {@link SwapMathError}-tagged Error
 * on InvalidPrice / Overflow. Ported from `clouds_math::swap_across_bins`.
 *
 * @example
 * // small swap stays in the active bin (book sorted, activeIndex centered)
 * swapAcrossBins(bins, ai, 25, 0, 0, 0, 100n, true).endBinId; // => active bin id
 */
export function swapAcrossBins(
  bins: MutBin[],
  activeIndex: number,
  binStepBps: number,
  feeBps: number,
  protocolFeeBps: number,
  treasuryFeeBps: number,
  amountIn: bigint,
  xForY: boolean,
): SwapResult {
  const activeBin = bins[activeIndex];
  if (activeIndex >= bins.length || activeBin === undefined) fail("InvalidPrice");

  // Both shares are bps OF THE SWAP FEE; clamp jointly so the sum <= 10_000:
  // protocol capped at 10_000 first, treasury at whatever bps remain. Matches
  // the on-chain clamp so program and router agree byte-for-byte.
  const pfBps = BigInt(Math.min(protocolFeeBps, 10_000));
  const tfBps = (() => {
    const remain = 10_000n - pfBps;
    const t = BigInt(treasuryFeeBps);
    return t < remain ? t : remain;
  })();

  let idx = activeIndex;
  let remaining = amountIn;
  let totalOut = 0n;
  let totalFee = 0n;
  let totalProtocolFee = 0n;
  let totalTreasuryFee = 0n;
  let lastBinId = activeBin.binId;
  let steps = 0;

  while (remaining > 0n && idx >= 0 && idx < bins.length) {
    if (steps >= MAX_BINS_PER_SWAP) break;
    steps += 1;

    const bin = bins[idx];
    if (bin === undefined) fail("InvalidPrice");
    lastBinId = bin.binId;
    const price = binPriceQ64(bin.binId, binStepBps);
    if (price === null) fail("InvalidPrice");

    const state: BinState = {
      priceQ64: price,
      reserveX: bin.reserveX,
      reserveY: bin.reserveY,
    };
    const fill = swapWithinBin(state, remaining, feeBps, xForY);

    // Split this fill's fee into protocol and treasury cuts (each a bps share
    // of the fee, left in the vault and not credited to any bin); the rest
    // stays in the bin for LPs. Each cut is the exact floor(fee*bps/10_000),
    // computed as q*bps + (r*bps)/10_000 with q = fee/10_000, r = fee%10_000;
    // the div+mod is shared by both cuts. The whole split is skipped when both
    // bps are zero (common on-chain path). Keeping the cuts separate preserves
    // each share's own floor (treasury is its own floor, not a residual).
    let protocolCut = 0n;
    let treasuryCut = 0n;
    if (pfBps !== 0n || tfBps !== 0n) {
      const q = fill.fee / 10_000n;
      const r = fill.fee % 10_000n;
      const cut = (bps: bigint): bigint => (bps === 0n ? 0n : q * bps + (r * bps) / 10_000n);
      protocolCut = cut(pfBps);
      treasuryCut = cut(tfBps);
    }
    const platformCut = protocolCut + treasuryCut;
    const toReserve = fill.amountIn - platformCut;

    // Apply the fill to this bin's reserves (LP share only).
    if (xForY) {
      // X (incl. LP fee) enters, Y leaves.
      const newX = bin.reserveX + toReserve;
      if (newX > U128_MAX) fail("Overflow");
      bin.reserveX = newX;
      const newY = bin.reserveY - fill.amountOut;
      if (newY < 0n) fail("Overflow");
      bin.reserveY = newY;
    } else {
      const newY = bin.reserveY + toReserve;
      if (newY > U128_MAX) fail("Overflow");
      bin.reserveY = newY;
      const newX = bin.reserveX - fill.amountOut;
      if (newX < 0n) fail("Overflow");
      bin.reserveX = newX;
    }

    totalOut += fill.amountOut;
    if (totalOut > U128_MAX) fail("Overflow");
    totalFee += fill.fee;
    if (totalFee > U128_MAX) fail("Overflow");
    totalProtocolFee += protocolCut;
    if (totalProtocolFee > U128_MAX) fail("Overflow");
    totalTreasuryFee += treasuryCut;
    if (totalTreasuryFee > U128_MAX) fail("Overflow");
    remaining -= fill.amountIn;

    if (fill.binExhausted && remaining > 0n) {
      // Advance to the adjacent bin in the direction of travel.
      idx += xForY ? -1 : 1;
    } else if (!fill.binExhausted) {
      // Bin absorbed the whole remaining input.
      break;
    }
  }

  return {
    amountInConsumed: amountIn - remaining,
    amountOut: totalOut,
    fee: totalFee,
    protocolFee: totalProtocolFee,
    treasuryFee: totalTreasuryFee,
    endBinId: lastBinId,
    amountInRemaining: remaining,
  };
}

/**
 * The protocol's effective take as a percentage of trade volume, formatted as
 * a `'%'` string: `protocolFeeBps * swapFeeBps / 1e6`. The protocol fee is a
 * share of the swap fee, so its slice of total volume is the product of the
 * two bps figures divided by 1e6.
 *
 * @example
 * // 100 bps swap fee, 5000 bps (50%) protocol share -> 0.5% of volume
 * protocolFeePctOfTrade(5000, 100); // => "0.5%"
 */
export function protocolFeePctOfTrade(protocolFeeBps: number, swapFeeBps: number): string {
  const pct = (protocolFeeBps * swapFeeBps) / 1_000_000;
  // Trim trailing zeros without forcing scientific notation.
  const s = pct.toFixed(6).replace(/\.?0+$/, "");
  return `${s}%`;
}
