/**
 * Bin pricing math for the Ponk Clouds DLMM.
 *
 * Two layers live here:
 *
 *  1. Float-decimal helpers for UIs ({@link priceOfBin} / {@link binIdForPrice}),
 *     ported verbatim from `dex-web/lib/ponkclouds.ts`. These produce a
 *     human, decimal-adjusted quote-per-base price for display and turn a
 *     human price back into the `active_bin_id` the program stores.
 *
 *  2. The exact integer Q64.64 price ({@link binPriceQ64}), ported bit-for-bit
 *     from `clouds-math/src/price.rs`. This is the price an off-chain swap
 *     quote must use so its output equals the on-chain result. It does base-
 *     factor construction, exponentiation-by-squaring over Q64.64, and the
 *     negative-bin reciprocal via floor(2^128 / d). No floats on this path.
 *
 * `price(bin_id) = (1 + bin_step / 10_000) ^ bin_id`, expressed as token Y
 * per token X. Rounding on the exact path floors toward the pool.
 */

import { Q64, BPS_DENOM } from "../constants";

/**
 * Human, decimal-adjusted price of `binId` (quote-per-base), for display.
 *
 * `(1 + binStepBps/1e4)^binId * 10^(decX - decY)`. Uses floats and is for
 * UI rendering only; never use it on the exact swap-quote path.
 *
 * @example
 * // bin 0 is always 1.0 before decimal adjustment
 * priceOfBin(0, 25, 9, 9); // => 1
 */
export function priceOfBin(
  binId: number,
  binStepBps: number,
  decX: number,
  decY: number,
): number {
  return Math.pow(1 + binStepBps / 10_000, binId) * Math.pow(10, decX - decY);
}

/**
 * Inverse of {@link priceOfBin}: the (rounded) bin id whose price is closest
 * to `price` (quote-per-base, decimal-adjusted) for a given bin step. Used by
 * the launch flow to turn a human price into the `active_bin_id` the program
 * stores. Returns null for a non-positive or non-finite price/bin step.
 *
 * The exact price of the returned bin will differ slightly from the input
 * because prices live on the discrete `(1 + binStep/1e4)^binId` grid; show
 * the resulting bin's price back so the creator confirms the real value.
 *
 * @example
 * // price 1.0 with equal decimals maps to bin 0
 * binIdForPrice(1, 25, 9, 9); // => 0
 */
export function binIdForPrice(
  price: number,
  binStepBps: number,
  decX: number,
  decY: number,
): number | null {
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(binStepBps) ||
    binStepBps <= 0
  ) {
    return null;
  }
  const base = 1 + binStepBps / 10_000;
  const adjusted = price * Math.pow(10, decY - decX);
  if (adjusted <= 0) return null;
  return Math.round(Math.log(adjusted) / Math.log(base));
}

const U64_MASK = (1n << 64n) - 1n;

/**
 * 128x128 -> 256-bit multiply, returned as `[low128, high128]`.
 *
 * Splits each operand into 64-bit halves (base 2^64) and sums the partial
 * products with explicit carry tracking. Ported from `mul_u128_full` in
 * `price.rs`. Inputs are treated as unsigned 128-bit; callers keep them in
 * range with masking.
 */
function mulU128Full(a: bigint, b: bigint): [bigint, bigint] {
  const aLo = a & U64_MASK;
  const aHi = a >> 64n;
  const bLo = b & U64_MASK;
  const bHi = b >> 64n;

  const ll = aLo * bLo;
  const lh = aLo * bHi;
  const hl = aHi * bLo;
  const hh = aHi * bHi;

  const mid = (ll >> 64n) + (lh & U64_MASK) + (hl & U64_MASK);
  const lo = (ll & U64_MASK) | ((mid << 64n) & ((1n << 128n) - 1n));
  const hi = hh + (lh >> 64n) + (hl >> 64n) + (mid >> 64n);
  return [lo, hi];
}

/**
 * Multiply two Q64.64 numbers, flooring the half-ulp result. Returns null on
 * overflow of the final value (mirrors the `Option` return of `mul_q64`).
 *
 * Computes the full 256-bit product then shifts right by 64; the result must
 * fit in u128, i.e. the product's high limb must be below 2^64.
 */
function mulQ64(a: bigint, b: bigint): bigint | null {
  const [lo, hi] = mulU128Full(a, b);
  // result = (hi:lo) >> 64 == (hi << 64) | (lo >> 64); must fit u128.
  if (hi >> 64n !== 0n) return null;
  return ((hi << 64n) | (lo >> 64n)) & ((1n << 128n) - 1n);
}

/**
 * Base factor `(1 + bin_step/10_000)` in Q64.64.
 * `= Q64 + (Q64 / 10_000) * bin_step_bps`. Ported from `base_factor_q64`.
 */
function baseFactorQ64(binStepBps: number): bigint {
  return Q64 + (Q64 / BPS_DENOM) * BigInt(binStepBps);
}

/**
 * floor(2^128 / d) for d >= 1, returned as a u128 bigint.
 *
 * 2^128 does not fit in u128 in Rust, so the original splits the long
 * division; here bigint is unbounded, but we keep the exact same correction
 * the Rust code uses (computing from `u128::MAX` and adding 1 when the
 * remainder rolls over) so results match bit-for-bit. Ported from
 * `div_2pow128_by`.
 */
function div2Pow128By(d: bigint): bigint {
  const U128_MAX = (1n << 128n) - 1n;
  const almost = U128_MAX / d; // floor((2^128 - 1)/d)
  const rem = U128_MAX % d;
  // 2^128 = (2^128 - 1) + 1, so 2^128/d = almost + (rem + 1 >= d ? 1 : 0)
  return rem + 1n >= d ? almost + 1n : almost;
}

/**
 * Exact Q64.64 price of `binId` (token Y per token X) for a bin step in bps.
 *
 * Returns null if the bin step is zero or the price over/underflows the
 * representable Q64.64 range (extreme bin ids), matching the `None` cases of
 * `clouds-math::bin_price_q64`. Intermediate multiplies floor, so the price
 * is a lower bound on the real value and swap math stays pool-favoring.
 *
 * @example
 * // bin 0 is exactly 1.0 in Q64.64
 * binPriceQ64(0, 25); // => Q64 (1n << 64n)
 * @example
 * // bin 1 equals the base factor (1 + step/1e4)
 * binPriceQ64(1, 100); // => Q64 + (Q64 / 10000n) * 100n
 */
export function binPriceQ64(binId: number, binStepBps: number): bigint | null {
  if (binStepBps === 0) return null;

  const factor = baseFactorQ64(binStepBps);
  const n = Math.abs(binId) >>> 0; // unsigned magnitude, mirrors unsigned_abs

  // Exponentiation by squaring in Q64.64.
  let result = Q64; // 1.0
  let acc = factor;
  let e = n;
  while (e > 0) {
    if ((e & 1) === 1) {
      const r = mulQ64(result, acc);
      if (r === null) return null;
      result = r;
    }
    e >>>= 1;
    if (e > 0) {
      const a = mulQ64(acc, acc);
      if (a === null) return null;
      acc = a;
    }
  }

  if (binId >= 0) {
    return result;
  }
  // Negative bin: price = 1 / result, in Q64.64 = floor(2^128 / result).
  if (result === 0n) return null;
  return div2Pow128By(result);
}
