/**
 * Display + unit-conversion helpers for the launch app.
 *
 * The honesty rule is enforced at this layer: a null/undefined metric renders
 * the literal {@link DASH} ("--"), never a fabricated 0 or guessed value. Money,
 * count, and percentage formatters all funnel through that null check, so a
 * component can pass an indexed value straight through and an unknown value is
 * always visibly unknown.
 *
 * The base-unit bridges ({@link toBaseUnits} / {@link fromBaseUnits}) are ported
 * verbatim from the dex `ponkclouds.ts` `toBaseUnits` so a human amount maps to
 * the exact bigint the SDK instruction builders expect, and back, with no
 * floating-point error on the conversion path.
 */

/** The honest placeholder rendered for any null/undefined value. */
export const DASH = "--";

/** True when a value is null or undefined (the things that render {@link DASH}). */
function isNullish(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/**
 * Format a USD amount, or {@link DASH} when null/undefined (unknown), with a
 * leading `$`. Sub-dollar amounts keep more precision so a tiny but real value
 * is not flattened to `$0.00`. NaN/Infinity render as {@link DASH} (never a
 * fake number).
 *
 * @param value USD amount, or null/undefined when the metric is unknown.
 */
export function formatUsd(value: number | null | undefined): string {
  if (isNullish(value) || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  let maximumFractionDigits = 2;
  if (abs > 0 && abs < 0.01) maximumFractionDigits = 6;
  else if (abs < 1) maximumFractionDigits = 4;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  })}`;
}

/**
 * Format a USD amount compactly (e.g. `$1.2M`, `$3.4K`) for KPI strips and pool
 * rows, or {@link DASH} when unknown. Values under $1,000 fall back to the plain
 * {@link formatUsd} rendering.
 *
 * @param value USD amount, or null/undefined when unknown.
 */
export function formatUsdCompact(value: number | null | undefined): string {
  if (isNullish(value) || !Number.isFinite(value)) return DASH;
  if (Math.abs(value) < 1000) return formatUsd(value);
  return `$${value.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format a plain number with grouping, or {@link DASH} when unknown.
 *
 * @param value The number, or null/undefined when unknown.
 * @param maximumFractionDigits Max decimals to show (default 0, for counts).
 */
export function formatNumber(
  value: number | null | undefined,
  maximumFractionDigits = 0,
): string {
  if (isNullish(value) || !Number.isFinite(value)) return DASH;
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

/**
 * Format a number compactly (e.g. `1.2M` swaps), or {@link DASH} when unknown.
 *
 * @param value The number, or null/undefined when unknown.
 */
export function formatNumberCompact(value: number | null | undefined): string {
  if (isNullish(value) || !Number.isFinite(value)) return DASH;
  if (Math.abs(value) < 1000) return formatNumber(value);
  return value.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

/**
 * Format a percentage, or {@link DASH} when unknown. The input is a PERCENT
 * value already (e.g. pass `12.5` for 12.5%, not `0.125`), matching how the
 * backend reports APR/fee ratios.
 *
 * @param value Percent value, or null/undefined when unknown.
 * @param maximumFractionDigits Max decimals to show (default 2).
 */
export function formatPct(
  value: number | null | undefined,
  maximumFractionDigits = 2,
): string {
  if (isNullish(value) || !Number.isFinite(value)) return DASH;
  return `${value.toLocaleString("en-US", { maximumFractionDigits })}%`;
}

/**
 * Format a basis-point value as a percent string (e.g. `4` bps -> `0.04%`), or
 * {@link DASH} when unknown. Used for the base-fee / bin-step chips.
 *
 * @param bps Basis points, or null/undefined when unknown.
 */
export function formatBps(bps: number | null | undefined): string {
  if (isNullish(bps) || !Number.isFinite(bps)) return DASH;
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/**
 * Truncate a base58 address to `head..tail` (default `4..4`), or {@link DASH}
 * when null/undefined. Short strings are returned unchanged.
 *
 * @param address The address, or null/undefined when unknown.
 * @param head Leading chars to keep (default 4).
 * @param tail Trailing chars to keep (default 4).
 */
export function shortenAddress(
  address: string | null | undefined,
  head = 4,
  tail = 4,
): string {
  if (isNullish(address)) return DASH;
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}..${address.slice(-tail)}`;
}

/**
 * The honest renderer for any value that may be unknown: returns the value's
 * string form, or {@link DASH} when it is null/undefined (or a non-finite
 * number). The single leaf-level enforcement of the no-fabrication rule.
 *
 * @param value Any displayable value, or null/undefined when unknown.
 */
export function orDash(value: string | number | null | undefined): string {
  if (isNullish(value)) return DASH;
  if (typeof value === "number" && !Number.isFinite(value)) return DASH;
  return String(value);
}

/**
 * Convert a human amount string to base units (a bigint), by `decimals`.
 *
 * Ported verbatim from the dex `ponkclouds.ts` `toBaseUnits`: rejects malformed
 * input (returns null for anything that is not a plain decimal), truncates the
 * fractional part to `decimals` places (no rounding, matching on-chain integer
 * semantics), and does the conversion in bigint so there is zero floating-point
 * error. Returns null for an empty / `"."` / non-numeric string so callers can
 * surface an honest "enter an amount" state rather than a fabricated 0.
 *
 * @param input Human amount, e.g. "1.25".
 * @param decimals The token's decimals.
 * @returns The amount in base units, or null when the input is not a valid
 *   non-negative decimal.
 */
export function toBaseUnits(input: string, decimals: number): bigint | null {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole = "", frac = ""] = t.split(".");
  const f = frac.slice(0, decimals).padEnd(decimals, "0");
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(f || "0");
  } catch {
    return null;
  }
}

/**
 * Convert base units (a bigint) to a human amount string, by `decimals`.
 *
 * The inverse of {@link toBaseUnits}, done entirely in bigint/string so there is
 * no precision loss for large balances. Trailing zeros in the fractional part
 * are trimmed; a whole amount returns no decimal point.
 *
 * @param base The amount in base units.
 * @param decimals The token's decimals.
 * @returns The human amount as a plain decimal string (never scientific
 *   notation).
 */
export function fromBaseUnits(base: bigint, decimals: number): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const denom = 10n ** BigInt(decimals);
  const whole = abs / denom;
  const frac = abs % denom;
  let out = whole.toString();
  if (decimals > 0 && frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (fracStr.length > 0) out += `.${fracStr}`;
  }
  return neg ? `-${out}` : out;
}

/**
 * Convert base units to a human NUMBER for display math (charts, sums). Uses
 * {@link fromBaseUnits} then `Number()`, so it inherits float limits only at the
 * very end (acceptable for rendering, never for tx amounts, which stay bigint).
 *
 * @param base The amount in base units (bigint or numeric string).
 * @param decimals The token's decimals.
 */
export function fromBaseUnitsNumber(
  base: bigint | string,
  decimals: number,
): number {
  const b = typeof base === "string" ? BigInt(base || "0") : base;
  return Number(fromBaseUnits(b, decimals));
}
