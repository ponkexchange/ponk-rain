/**
 * Low-level little-endian byte codecs for the Ponk Clouds AMM wire format,
 * plus a couple of human/base-unit amount conversions.
 *
 * The Ponk Clouds program (a bin-based DLMM AMM with zero protocol fee at the
 * AMM level) encodes every Anchor instruction argument and account field in
 * little-endian order. These primitives are the single source of truth for
 * that encoding/decoding so that PDA-seed derivation (pda.ts), instruction
 * builders (swap.ts, fees.ts, position.ts, rain/createPool.ts) and account
 * decoders (pool.ts, position.ts) all agree byte for byte.
 *
 * The byte emitters (`u16le`, `i32le`, `u64le`, `u128le`) return a fresh
 * `Uint8Array` so they compose cleanly as PDA seeds and as parts for
 * `concatBytes`. `concatBytes` returns a Node `Buffer` because that is the
 * type `@solana/web3.js`'s `TransactionInstruction.data` field expects. The
 * readers (`readU128LE`) take a byte view plus an offset and return a `bigint`,
 * since reserves, shares and fee accumulators are `u128` values that do not fit
 * in a JS number.
 *
 * This module has no dependency on `@solana/web3.js`; it works purely with
 * `Uint8Array`/`Buffer`/`DataView` so it can be imported from anywhere.
 */

/**
 * Encode a `u16` as 2 little-endian bytes. Used for `binStep` (in PDA seeds and
 * the `initialize_pool` arg list) and for the fee basis-point arguments.
 *
 * @param n Unsigned 16-bit value, `0 <= n <= 65535`.
 * @returns A fresh 2-byte little-endian `Uint8Array`.
 */
export function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

/**
 * Encode an `i32` as 4 little-endian bytes. Used for signed bin ids
 * (`activeBinId`, `startBin`, `lowerBinId`, `upperBinId`, `binId`) in PDA seeds
 * and instruction arguments. The active bin and position bounds are signed
 * because bins span both sides of the reference price.
 *
 * @param n Signed 32-bit value, `-2147483648 <= n <= 2147483647`.
 * @returns A fresh 4-byte little-endian `Uint8Array`.
 */
export function i32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

/**
 * Encode a `u64` as 8 little-endian bytes. Used for token amounts that fit in
 * 64 bits (swap `amountIn`/`minOut`, deposit `amountX`/`amountY`). The argument
 * is a `bigint` so the full unsigned 64-bit range is representable exactly.
 *
 * @param n Unsigned 64-bit value, `0n <= n <= 2n ** 64n - 1n`.
 * @returns A fresh 8-byte little-endian `Uint8Array`.
 */
export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/**
 * Encode a `u128` as 16 little-endian bytes. Used for LP share quantities
 * (`removeLiquidity` `shares`) that the program tracks at `u128` precision. The
 * value is split into two little-endian `u64` halves to stay within the
 * `DataView` API.
 *
 * @param n Unsigned 128-bit value, `0n <= n <= 2n ** 128n - 1n`.
 * @returns A fresh 16-byte little-endian `Uint8Array`.
 */
export function u128le(n: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, n & 0xffffffffffffffffn, true);
  dv.setBigUint64(8, (n >> 64n) & 0xffffffffffffffffn, true);
  return b;
}

/**
 * Read a little-endian `u128` from `data` starting at byte offset `o`,
 * returning a `bigint`. Used to decode pool/bin/treasury reserves, total
 * shares, and accrued protocol/treasury fee accumulators from raw account
 * data, all of which the program stores as `u128`.
 *
 * @param data Raw account bytes (or any byte view) to read from.
 * @param o Byte offset of the little-endian `u128` field.
 * @returns The decoded value as a `bigint`.
 */
export function readU128LE(data: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i -= 1) v = (v << 8n) | BigInt(data[o + i]!);
  return v;
}

/**
 * Concatenate byte parts into a single contiguous `Buffer`. Instruction
 * builders use this to glue an 8-byte Anchor discriminator to its encoded
 * arguments; the `Buffer` return type matches `TransactionInstruction.data`.
 *
 * @param parts Byte chunks to join, in order.
 * @returns A new `Buffer` containing every part back to back.
 */
export function concatBytes(parts: Uint8Array[]): Buffer {
  const len = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return Buffer.from(out);
}

/**
 * Convert a human-readable decimal amount into raw base units for a mint with
 * `decimals` decimal places, e.g. `toBaseUnits("1.5", 6) === 1_500_000n`.
 *
 * Parsing is exact and integer-only: the input is split on the decimal point
 * and recombined as a `bigint`, so there is no floating-point rounding. Any
 * fractional digits beyond `decimals` are truncated (the program cannot hold
 * sub-base-unit precision). Throws on malformed input.
 *
 * @param amount Decimal amount as a string (preferred for exactness) or number.
 * @param decimals Mint decimals, `0 <= decimals <= 255`.
 * @returns The amount expressed in raw base units as a `bigint`.
 */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!/^-?\d*\.?\d*$/.test(s) || s === "" || s === "." || s === "-") {
    throw new Error(`toBaseUnits: invalid amount "${amount}"`);
  }
  const negative = s.startsWith("-");
  const unsigned = negative ? s.slice(1) : s;
  const [whole = "", frac = ""] = unsigned.split(".");
  const scale = 10n ** BigInt(decimals);
  const wholePart = (whole === "" ? 0n : BigInt(whole)) * scale;
  const fracDigits = frac.slice(0, decimals).padEnd(decimals, "0");
  const fracPart = decimals === 0 || fracDigits === "" ? 0n : BigInt(fracDigits);
  const total = wholePart + fracPart;
  return negative ? -total : total;
}

/**
 * Convert a raw base-unit amount into a human-readable decimal string for a
 * mint with `decimals` decimal places, e.g. `fromBaseUnits(1_500_000n, 6)`
 * returns `"1.5"`. The result has no trailing zeros and no trailing decimal
 * point, and is exact (no floating-point involved).
 *
 * @param amount Raw base-unit amount as a `bigint`.
 * @param decimals Mint decimals, `0 <= decimals <= 255`.
 * @returns The decimal string representation of the amount.
 */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac === "" ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}
