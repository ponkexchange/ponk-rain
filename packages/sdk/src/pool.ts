/**
 * Pool state reading and decoding for the Ponk Clouds program.
 *
 * Decodes the on-chain `Pool`, `BinArray`, `BinSlot` and `PoolTreasury`
 * accounts at their exact byte offsets (ported from the program's `state.rs`
 * and the `dex-web/lib/ponkclouds.ts` helpers), resolves a pool's display
 * metadata directly from chain, discovers every Ponk Clouds pool via
 * `getProgramAccounts`, and reads the bin distribution and recent activity
 * needed by liquidity charts and pool pages.
 *
 * Reserves and shares are `u128` on-chain and surface as `bigint`. Nothing is
 * fabricated: empty bins read as zero, unknown symbols fall back to a short
 * mint label, and RPC failures during discovery yield an empty list so callers
 * can degrade gracefully rather than crash.
 *
 * On-chain `Pool` layout (8-byte Anchor discriminator + fields):
 *   authority      Pubkey  @ 8
 *   token_mint_x   Pubkey  @ 40
 *   token_mint_y   Pubkey  @ 72
 *   vault_x        Pubkey  @ 104
 *   vault_y        Pubkey  @ 136
 *   bin_step_bps   u16     @ 168
 *   swap_fee_bps   u16     @ 170
 *   protocol_fee_bps u16   @ 172
 *   active_bin_id  i32     @ 174
 *   paused         bool    @ 178
 *   bump           u8      @ 179
 *   protocol_fee_x u128    @ 180
 *   protocol_fee_y u128    @ 196
 *   (total size 212 bytes)
 *
 * `BinArray`: 8 disc + 32 pool + 4 start_bin_id + 4 vec-len, then 70 slots of
 * 48 bytes each (reserve_x u128, reserve_y u128, total_shares u128), then a
 * trailing bump u8.
 *
 * `PoolTreasury`: 8 disc + 32 pool + 32 treasury + 2 treasury_fee_bps +
 * 1 bump + 16 treasury_fee_x u128 (@75) + 16 treasury_fee_y u128 (@91).
 */

import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

import {
  PONK_CLOUDS_PROGRAM_ID,
  NATIVE_MINT_STR,
  POOL_ACCOUNT_SIZE,
} from "./constants";
import { readU128LE } from "./codec";
import {
  poolPda,
  binArrayPda,
  arrayStartForBin,
  poolTreasuryPda,
} from "./pda";
import { priceOfBin } from "./math/price";
import type {
  CloudsPool,
  PoolInfo,
  BinSlot,
  DecodedBinArray,
  PoolTreasuryConfig,
  ChartBin,
  BinDistribution,
  PoolActivity,
  ActivityKind,
} from "./types";

/** Number of bins per `BinArray` account (mirrors `state.rs::BINS_PER_ARRAY`). */
const BINS_PER_ARRAY = 70;

/** Byte size of a single `BinSlot` (three u128: reserve_x, reserve_y, shares). */
const BIN_SLOT_SIZE = 48;

/** Header bytes preceding the first `BinSlot` in a `BinArray` account:
 * 8 disc + 32 pool + 4 start_bin_id + 4 vec-len. */
const BIN_ARRAY_HEADER = 48;

/**
 * Short pubkey label for an unknown mint (`Xxxx..Xxxx`). Used as an honest
 * fallback when no symbol resolver maps the mint; never fabricates a name.
 */
function shortMint(mint: string): string {
  return mint.length > 8 ? `${mint.slice(0, 4)}..${mint.slice(-4)}` : mint;
}

/**
 * Read an SPL mint account's decimals. The SPL `Mint` layout stores `decimals`
 * as a `u8` at byte offset 44. wSOL always has 9 decimals; any other mint whose
 * account is missing or truncated reads as 0 (honest unknown, never guessed).
 */
function decimalsOf(account: { data: Uint8Array } | null, mint: string): number {
  if (account && account.data.length >= 45) {
    return account.data[44]!;
  }
  return mint === NATIVE_MINT_STR ? 9 : 0;
}

/**
 * Decode a `Pool` account at its exact byte offsets into the typed
 * {@link CloudsPool} shape. The caller supplies the account `address` (the
 * pool PDA) since it is not stored inside the account data.
 */
export function decodePool(address: PublicKey, data: Uint8Array): CloudsPool {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    address,
    authority: new PublicKey(data.subarray(8, 40)),
    mintX: new PublicKey(data.subarray(40, 72)),
    mintY: new PublicKey(data.subarray(72, 104)),
    vaultX: new PublicKey(data.subarray(104, 136)),
    vaultY: new PublicKey(data.subarray(136, 168)),
    binStepBps: dv.getUint16(168, true),
    swapFeeBps: dv.getUint16(170, true),
    protocolFeeBps: dv.getUint16(172, true),
    activeBinId: dv.getInt32(174, true),
    paused: data[178] !== 0,
    bump: data[179]!,
    protocolFeeX: readU128LE(data, 180),
    protocolFeeY: readU128LE(data, 196),
  };
}

/**
 * Decode a single `BinSlot` (reserve_x, reserve_y, total_shares) from a
 * `BinArray` account. `startBin` is the array's `start_bin_id` and `binId` the
 * absolute bin being read; the slot index is their difference.
 */
export function decodeBinSlot(
  data: Uint8Array,
  startBin: number,
  binId: number,
): BinSlot {
  const local = binId - startBin;
  const off = BIN_ARRAY_HEADER + local * BIN_SLOT_SIZE;
  return {
    reserveX: readU128LE(data, off),
    reserveY: readU128LE(data, off + 16),
    totalShares: readU128LE(data, off + 32),
  };
}

/**
 * Decode a full `BinArray` account into its pool, `start_bin_id`, the 70
 * `BinSlot`s in order, and the trailing bump. The vec length is read from the
 * header but the slot region is always 70 slots wide (fixed `max_len`), so a
 * shorter populated prefix still reads zeros for the remainder.
 */
export function decodeBinArray(data: Uint8Array): DecodedBinArray {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pool = new PublicKey(data.subarray(8, 40));
  const startBinId = dv.getInt32(40, true);
  const slots: BinSlot[] = [];
  for (let i = 0; i < BINS_PER_ARRAY; i += 1) {
    const off = BIN_ARRAY_HEADER + i * BIN_SLOT_SIZE;
    slots.push({
      reserveX: readU128LE(data, off),
      reserveY: readU128LE(data, off + 16),
      totalShares: readU128LE(data, off + 32),
    });
  }
  const bumpOff = BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SLOT_SIZE;
  const bump = data.length > bumpOff ? data[bumpOff]! : 0;
  return { pool, startBinId, slots, bump };
}

/**
 * Decode a `PoolTreasury` account into its typed {@link PoolTreasuryConfig}.
 * The caller supplies the treasury PDA `address` (derived from the pool).
 *
 * Layout: 8 disc + 32 pool + 32 treasury + 2 treasury_fee_bps + 1 bump +
 * 16 treasury_fee_x (@75) + 16 treasury_fee_y (@91).
 */
export function decodePoolTreasury(
  address: PublicKey,
  data: Uint8Array,
): PoolTreasuryConfig {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    address,
    pool: new PublicKey(data.subarray(8, 40)),
    treasury: new PublicKey(data.subarray(40, 72)),
    treasuryFeeBps: dv.getUint16(72, true),
    bump: data[74]!,
    treasuryFeeX: readU128LE(data, 75),
    treasuryFeeY: readU128LE(data, 91),
  };
}

/**
 * Fetch and decode the pool for a `(mintX, mintY, binStep)` triple. Returns
 * null when no such pool account exists, it is not owned by the Clouds
 * program, or it is too small to hold the fixed `Pool` prefix.
 */
export async function fetchPool(
  conn: Connection,
  mintX: PublicKey,
  mintY: PublicKey,
  binStep: number,
): Promise<CloudsPool | null> {
  const pool = poolPda(mintX, mintY, binStep);
  return fetchPoolByAddress(conn, pool);
}

/**
 * Fetch and decode the pool at an explicit address. Returns null when the
 * account is absent, not owned by the Clouds program, or too short to hold the
 * full 212-byte `Pool` layout.
 */
export async function fetchPoolByAddress(
  conn: Connection,
  pool: PublicKey,
): Promise<CloudsPool | null> {
  const acc = await conn.getAccountInfo(pool);
  if (
    !acc ||
    !acc.owner.equals(PONK_CLOUDS_PROGRAM_ID) ||
    acc.data.length < POOL_ACCOUNT_SIZE
  ) {
    return null;
  }
  return decodePool(pool, acc.data);
}

/**
 * Fetch and decode a pool's treasury (platform-fee) config. Returns null when
 * the per-pool treasury PDA does not exist (the pool then behaves as if the
 * treasury cut were zero), is not owned by the Clouds program, or is truncated.
 */
export async function fetchPoolTreasury(
  conn: Connection,
  pool: PublicKey,
): Promise<PoolTreasuryConfig | null> {
  const treasury = poolTreasuryPda(pool);
  const acc = await conn.getAccountInfo(treasury);
  // 8 disc + 32 + 32 + 2 + 1 + 16 + 16 = 107 bytes.
  if (
    !acc ||
    !acc.owner.equals(PONK_CLOUDS_PROGRAM_ID) ||
    acc.data.length < 107
  ) {
    return null;
  }
  return decodePoolTreasury(treasury, acc.data);
}

/**
 * Resolve a Ponk Clouds pool's display metadata DIRECTLY FROM CHAIN by address.
 *
 * Reads the `Pool` account (mint_x@40, mint_y@72, bin_step@168) and the two SPL
 * mint accounts for decimals, then labels each mint via the optional
 * `resolveSymbol` callback with an honest short-mint fallback. Nothing is
 * fabricated. Returns null when the address is not a valid pubkey, the account
 * is missing/not owned by the Clouds program, or it is too short to hold the
 * prefix through `bin_step_bps`.
 */
export async function readPoolInfoOnChain(
  conn: Connection,
  address: string,
  opts?: { resolveSymbol?: (mint: string) => string | null },
): Promise<PoolInfo | null> {
  let poolKey: PublicKey;
  try {
    poolKey = new PublicKey(address);
  } catch {
    return null;
  }
  const acc = await conn.getAccountInfo(poolKey);
  // Must exist, be owned by the Clouds program, and be large enough to hold the
  // fixed prefix through bin_step_bps (170 bytes).
  if (!acc || !acc.owner.equals(PONK_CLOUDS_PROGRAM_ID) || acc.data.length < 170) {
    return null;
  }
  const data = acc.data;
  const mintX = new PublicKey(data.subarray(40, 72)).toBase58();
  const mintY = new PublicKey(data.subarray(72, 104)).toBase58();
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const binStep = dv.getUint16(168, true);

  const [mxAcc, myAcc] = await conn.getMultipleAccountsInfo([
    new PublicKey(mintX),
    new PublicKey(mintY),
  ]);
  const decimalsX = decimalsOf(mxAcc ?? null, mintX);
  const decimalsY = decimalsOf(myAcc ?? null, mintY);

  const symFor = (mint: string): string =>
    opts?.resolveSymbol?.(mint) ?? shortMint(mint);
  const symbolX = symFor(mintX);
  const symbolY = symFor(mintY);

  return {
    address,
    name: `${symbolX} / ${symbolY}`,
    mintX,
    symbolX,
    decimalsX,
    mintY,
    symbolY,
    decimalsY,
    binStep,
  };
}

/**
 * Discover EVERY Ponk Clouds pool on chain via `getProgramAccounts`, so pools a
 * user created (via Rain) appear without being hand-listed anywhere. Filters to
 * `Pool`-sized accounts and slices only the bytes needed (mint_x@40, mint_y@72,
 * bin_step@168), then batch-reads the distinct mints' decimals. Symbols come
 * from the optional `resolveSymbol` callback with an honest short-mint fallback.
 *
 * Returns `[]` on RPC failure so callers can fall back to a curated list rather
 * than surfacing an error.
 */
export async function discoverPools(
  conn: Connection,
  opts?: { resolveSymbol?: (mint: string) => string | null },
): Promise<PoolInfo[]> {
  let accounts;
  try {
    accounts = await conn.getProgramAccounts(PONK_CLOUDS_PROGRAM_ID, {
      filters: [{ dataSize: POOL_ACCOUNT_SIZE }],
      // Slice from mint_x (40) through bin_step (168..170): 130 bytes covers
      // mint_x@[0,32), mint_y@[32,64), bin_step@[128,130) in slice-local coords.
      dataSlice: { offset: 40, length: 130 },
    });
  } catch {
    return [];
  }

  const decoded = accounts.map(({ pubkey, account }) => {
    const d = account.data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return {
      address: pubkey.toBase58(),
      mintX: new PublicKey(d.subarray(0, 32)).toBase58(),
      mintY: new PublicKey(d.subarray(32, 64)).toBase58(),
      binStep: dv.getUint16(128, true),
    };
  });

  // Batch-read decimals for the distinct mints (SPL Mint: decimals u8 @ 44).
  const mints = [...new Set(decoded.flatMap((d) => [d.mintX, d.mintY]))];
  const decimalsByMint = new Map<string, number>();
  try {
    const infos = await conn.getMultipleAccountsInfo(
      mints.map((m) => new PublicKey(m)),
    );
    infos.forEach((a, i) => {
      const m = mints[i]!;
      decimalsByMint.set(m, decimalsOf(a, m));
    });
  } catch {
    for (const m of mints) {
      decimalsByMint.set(m, m === NATIVE_MINT_STR ? 9 : 0);
    }
  }

  const symFor = (mint: string): string =>
    opts?.resolveSymbol?.(mint) ?? shortMint(mint);
  return decoded.map((d): PoolInfo => {
    const symbolX = symFor(d.mintX);
    const symbolY = symFor(d.mintY);
    return {
      address: d.address,
      name: `${symbolX} / ${symbolY}`,
      mintX: d.mintX,
      symbolX,
      decimalsX: decimalsByMint.get(d.mintX) ?? 0,
      mintY: d.mintY,
      symbolY,
      decimalsY: decimalsByMint.get(d.mintY) ?? 0,
      binStep: d.binStep,
    };
  });
}

/**
 * Read every bin in `[active - radius, active + radius]` straight from the
 * program's bin arrays, in human units. Empty bins are returned as zero
 * (honest), never guessed. Throws if the pool account is missing at this RPC.
 */
export async function readBinDistribution(
  conn: Connection,
  info: PoolInfo,
  radius = 30,
): Promise<BinDistribution> {
  const mintX = new PublicKey(info.mintX);
  const mintY = new PublicKey(info.mintY);
  const pool = poolPda(mintX, mintY, info.binStep);
  const poolAcc = await conn.getAccountInfo(pool);
  if (!poolAcc) throw new Error("Ponk Clouds pool not found at this RPC");
  const decoded = decodePool(pool, poolAcc.data);
  const active = decoded.activeBinId;
  const lo = active - radius;
  const hi = active + radius;

  // Distinct bin arrays covering the window.
  const starts = new Set<number>();
  for (let b = lo; b <= hi; b += 1) starts.add(arrayStartForBin(b));
  const startList = [...starts];
  const accts = await conn.getMultipleAccountsInfo(
    startList.map((s) => binArrayPda(pool, s)),
  );
  const byStart = new Map<number, Uint8Array | null>();
  startList.forEach((s, i) => byStart.set(s, accts[i] ? accts[i]!.data : null));

  const dX = Math.pow(10, info.decimalsX);
  const dY = Math.pow(10, info.decimalsY);
  const bins: ChartBin[] = [];
  for (let b = lo; b <= hi; b += 1) {
    const start = arrayStartForBin(b);
    const data = byStart.get(start) ?? null;
    const slot = data
      ? decodeBinSlot(data, start, b)
      : { reserveX: 0n, reserveY: 0n, totalShares: 0n };
    bins.push({
      binId: b,
      price: priceOfBin(b, decoded.binStepBps, info.decimalsX, info.decimalsY),
      reserveX: Number(slot.reserveX) / dX,
      reserveY: Number(slot.reserveY) / dY,
      totalShares: slot.totalShares,
      isActive: b === active,
    });
  }
  return {
    activeBinId: active,
    binStepBps: decoded.binStepBps,
    swapFeeBps: decoded.swapFeeBps,
    protocolFeeBps: decoded.protocolFeeBps,
    bins,
  };
}

/**
 * Recent on-chain activity touching the pool, classified from how the pool's
 * two vaults moved: both up = Add, both down = Withdraw, opposite = Swap, and
 * anything ambiguous = Activity. Amounts are the net vault deltas in human
 * units (signed, positive into the pool). Vault movement is read from the
 * pool's own associated token accounts so only real reserve flow is counted.
 */
export async function readPoolActivity(
  conn: Connection,
  info: PoolInfo,
  limit = 15,
): Promise<PoolActivity[]> {
  const mintX = new PublicKey(info.mintX);
  const mintY = new PublicKey(info.mintY);
  const pool = poolPda(mintX, mintY, info.binStep);
  const poolStr = pool.toBase58();
  // The pool's vaults are its own ATAs; parsed token-balance entries are keyed
  // by the owning pool PDA, so we match on `owner === poolStr` below.
  const sigs = await conn.getSignaturesForAddress(pool, { limit });
  const txs = await Promise.all(
    sigs.map((s) =>
      conn
        .getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
        .catch(() => null),
    ),
  );

  const EPS = 1e-9;
  return sigs.map((s, i) => {
    const tx = txs[i];
    let dX = 0;
    let dY = 0;
    let signer: string | null = null;
    if (tx?.meta) {
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const amt = (
        arr: NonNullable<typeof tx.meta.preTokenBalances>,
        mint: string,
      ): number => {
        const e = arr.find((b) => b.mint === mint && b.owner === poolStr);
        return e?.uiTokenAmount.uiAmount ?? 0;
      };
      dX = amt(post, info.mintX) - amt(pre, info.mintX);
      dY = amt(post, info.mintY) - amt(pre, info.mintY);
      const k0 = tx.transaction.message.accountKeys?.[0];
      signer = k0 ? k0.pubkey.toBase58() : null;
    }
    const up = (v: number) => v > EPS;
    const down = (v: number) => v < -EPS;
    let kind: ActivityKind = "Activity";
    if ((up(dX) || up(dY)) && !down(dX) && !down(dY)) kind = "Add";
    else if ((down(dX) || down(dY)) && !up(dX) && !up(dY)) kind = "Withdraw";
    else if ((up(dX) && down(dY)) || (down(dX) && up(dY))) kind = "Swap";
    return {
      signature: s.signature,
      blockTime: s.blockTime ?? null,
      err: !!s.err,
      kind,
      deltaX: dX,
      deltaY: dY,
      signer,
    };
  });
}
