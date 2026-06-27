/**
 * Pure single-bin share accounting, ported bit-for-bit from
 * `clouds-math/src/liquidity.rs`, plus the range planner ported from
 * `dex-web/lib/ponkclouds.ts`.
 *
 * Each bin tracks `totalShares` and its reserves. A deposit mints shares
 * proportional to the value it adds (min-of-sides, rounded DOWN) and refunds
 * the surplus on the over-supplied side; a withdrawal burns shares for a
 * proportional, floored slice of reserves. Rounding always favors the pool.
 *
 * {@link previewDeposit} returns exactly what the program will mint and pull.
 * Unlike the Rust `deposit` (which returns `Err(MinLiquidity)` / `Err(Overflow)`),
 * the preview is non-throwing: when the program would revert (a dust seed
 * below MIN_LIQUIDITY, or a zero deposit) it reports `sharesMinted: 0` so a UI
 * can disable the action without a thrown error.
 *
 * {@link planRange} lays out a DLMM deposit around the active bin for the
 * spot/curve/bidask/full strategies: base (X) above the active price, quote
 * (Y) below, the active bin skipped unless `spread === 0`.
 */

import { MIN_LIQUIDITY } from "../constants";
import type { DepositPreview, Strategy, RangePlan, RangePlanBin } from "../types";

/** A bin's liquidity bookkeeping (raw base units / shares). */
export interface BinLiquidity {
  totalShares: bigint;
  reserveX: bigint;
  reserveY: bigint;
}

const U128_MAX = (1n << 128n) - 1n;

/** floor(a * b / c) for c > 0; null on overflow of the u128 result. */
function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint | null {
  if (c === 0n) return null;
  const q = (a * b) / c;
  return q > U128_MAX ? null : q;
}

/** ceil(a * b / c) for c > 0; null on overflow of the u128 result. */
function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint | null {
  if (c === 0n) return null;
  const p = a * b;
  const floor = p / c;
  const ceil = p % c === 0n ? floor : floor + 1n;
  return ceil > U128_MAX ? null : ceil;
}

/**
 * Preview a deposit of `addX` / `addY` into a bin: the shares minted and the
 * reserves actually pulled. Mirrors `clouds_math::deposit`.
 *
 * First deposit into an empty bin seeds shares as the sum of deposited
 * reserves, but only if that sum is at least MIN_LIQUIDITY (dust seeds would
 * revert on-chain, so they preview as `sharesMinted: 0`). Subsequent deposits
 * mint pro-rata to the present sides (the MINIMUM implied, rounded DOWN) and
 * pull only the reserves that back those shares, refunding the surplus on the
 * over-supplied side (each used side rounded UP, capped at what was offered).
 *
 * Returns `{ sharesMinted: 0n, usedX: 0n, usedY: 0n }` for a zero deposit, a
 * dust seed, or an overflow, matching the cases the program rejects.
 *
 * @example
 * // off-ratio second deposit refunds the surplus side
 * previewDeposit({ totalShares: 2_000n, reserveX: 1_000n, reserveY: 1_000n }, 100n, 50n);
 * // => { sharesMinted: 100n, usedX: 50n, usedY: 50n }  (extra 50 X refunded)
 */
export function previewDeposit(bin: BinLiquidity, addX: bigint, addY: bigint): DepositPreview {
  const none: DepositPreview = { sharesMinted: 0n, usedX: 0n, usedY: 0n };
  if (addX === 0n && addY === 0n) return none;

  if (bin.totalShares === 0n || (bin.reserveX === 0n && bin.reserveY === 0n)) {
    // Seed: shares = added reserves. Reject a dust seed (would revert on-chain).
    const seed = addX + addY;
    if (seed > U128_MAX) return none; // overflow
    if (seed < MIN_LIQUIDITY) return none; // MinLiquidity
    return { sharesMinted: seed, usedX: addX, usedY: addY };
  }

  // Pro-rata: mint the MINIMUM implied by the present sides (round down) so a
  // lopsided deposit cannot mint extra.
  let implied: bigint | null = null;
  if (bin.reserveX > 0n && addX > 0n) {
    const s = mulDivFloor(addX, bin.totalShares, bin.reserveX);
    if (s === null) return none; // overflow
    implied = implied === null ? s : implied < s ? implied : s;
  }
  if (bin.reserveY > 0n && addY > 0n) {
    const s = mulDivFloor(addY, bin.totalShares, bin.reserveY);
    if (s === null) return none; // overflow
    implied = implied === null ? s : implied < s ? implied : s;
  }
  const shares = implied ?? 0n;

  // Pull only the reserves that back `shares` (round UP, pool never short-
  // changed), capped at what the depositor offered; the surplus is refunded.
  let usedX = 0n;
  if (bin.reserveX > 0n && shares > 0n) {
    const u = mulDivCeil(shares, bin.reserveX, bin.totalShares);
    if (u === null) return none; // overflow
    usedX = u < addX ? u : addX;
  }
  let usedY = 0n;
  if (bin.reserveY > 0n && shares > 0n) {
    const u = mulDivCeil(shares, bin.reserveY, bin.totalShares);
    if (u === null) return none; // overflow
    usedY = u < addY ? u : addY;
  }
  return { sharesMinted: shares, usedX, usedY };
}

/**
 * Preview a withdrawal of `shares` from a bin: the proportional reserves
 * returned, floored so the pool never over-pays (burned dust stays with the
 * remaining LPs). Mirrors `clouds_math::withdraw`.
 *
 * Returns `{ outX: 0n, outY: 0n }` for a zero/empty withdraw or one that
 * exceeds the bin's total shares (which the program rejects).
 *
 * @example
 * previewWithdraw({ totalShares: 1_000n, reserveX: 800n, reserveY: 200n }, 500n);
 * // => { outX: 400n, outY: 100n }
 */
export function previewWithdraw(
  bin: BinLiquidity,
  shares: bigint,
): { outX: bigint; outY: bigint } {
  if (shares === 0n || bin.totalShares === 0n) return { outX: 0n, outY: 0n };
  if (shares > bin.totalShares) return { outX: 0n, outY: 0n };
  const outX = mulDivFloor(bin.reserveX, shares, bin.totalShares);
  const outY = mulDivFloor(bin.reserveY, shares, bin.totalShares);
  if (outX === null || outY === null) return { outX: 0n, outY: 0n };
  return { outX, outY };
}

/**
 * Per-side weight by distance `d` from the active bin, for the OFF-active bins
 * only (d = 1..spread; the active bin is handled separately as the one mixed
 * bin). Spot/full are uniform; curve peaks nearest the price and tapers;
 * bid-ask peaks at the edges. Ported from `sideWeights`.
 */
function sideWeights(spread: number, strategy: Strategy): number[] {
  const w: number[] = [];
  for (let d = 1; d <= spread; d += 1) {
    if (strategy === "curve") w.push(spread + 1 - d);
    else if (strategy === "bidask") w.push(d + 1);
    else w.push(1); // spot, full
  }
  return w;
}

/**
 * Split `total` across bins by integer weights, remainder to the heaviest
 * bin, so the per-bin amounts sum back to exactly `total`. Ported from
 * `distribute`.
 */
function distribute(total: bigint, weights: number[]): bigint[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW === 0 || total === 0n) return weights.map(() => 0n);
  const sumB = BigInt(sumW);
  const out = weights.map((w) => (total * BigInt(w)) / sumB);
  const used = out.reduce((a, b) => a + b, 0n);
  const rem = total - used;
  if (rem > 0n) {
    let mi = 0;
    for (let i = 1; i < weights.length; i += 1) {
      if ((weights[i] ?? 0) > (weights[mi] ?? 0)) mi = i;
    }
    out[mi] = (out[mi] ?? 0n) + rem;
  }
  return out;
}

/**
 * Plan a DLMM deposit around the active bin for a given strategy.
 *
 * Base (X) fills bins STRICTLY ABOVE the active price; quote (Y) fills bins
 * STRICTLY BELOW. The active bin is deliberately skipped: it is the one bin
 * that holds both reserves, so any off-ratio X/Y pair sent to it is partially
 * refunded by the program. Bins above active are pure-X and bins below pure-Y
 * (a DLMM invariant), so single-sided deposits there are taken in full; the
 * strategy only reshapes the weighting within each side.
 *
 * `spread === 0` is the single-bin (active-only) case: with no off-active bin
 * to use, it deposits both legs into the active bin (the program still refunds
 * any off-ratio surplus, but that is the caller's explicit choice). Ported
 * from `planRange`.
 *
 * @example
 * // spot, spread 1: X above active, Y below, active skipped
 * planRange(100, 1, 10n, 10n, "spot");
 * // => { lower: 99, upper: 101, bins: [ {binId:99,amountX:0n,amountY:10n}, {binId:101,amountX:10n,amountY:0n} ] }
 */
export function planRange(
  activeBin: number,
  spread: number,
  totalX: bigint,
  totalY: bigint,
  strategy: Strategy,
): RangePlan {
  const lower = activeBin - spread;
  const upper = activeBin + spread;

  if (spread === 0) {
    const bins: RangePlanBin[] =
      totalX > 0n || totalY > 0n
        ? [{ binId: activeBin, amountX: totalX, amountY: totalY }]
        : [];
    return { lower, upper, bins };
  }

  const w = sideWeights(spread, strategy); // weights for d = 1..spread
  const xAmts = distribute(totalX, w); // xAmts[i] -> bin activeBin + (i + 1)
  const yAmts = distribute(totalY, w); // yAmts[i] -> bin activeBin - (i + 1)
  const map = new Map<number, { x: bigint; y: bigint }>();
  for (let i = 0; i < w.length; i += 1) {
    const d = i + 1;
    const xi = xAmts[i] ?? 0n;
    const yi = yAmts[i] ?? 0n;
    if (xi > 0n) {
      const above = map.get(activeBin + d) ?? { x: 0n, y: 0n };
      above.x += xi;
      map.set(activeBin + d, above);
    }
    if (yi > 0n) {
      const below = map.get(activeBin - d) ?? { x: 0n, y: 0n };
      below.y += yi;
      map.set(activeBin - d, below);
    }
  }
  const bins: RangePlanBin[] = [];
  for (let b = lower; b <= upper; b += 1) {
    const m = map.get(b);
    if (m && (m.x > 0n || m.y > 0n)) bins.push({ binId: b, amountX: m.x, amountY: m.y });
  }
  return { lower, upper, bins };
}
