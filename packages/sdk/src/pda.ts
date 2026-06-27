/**
 * Deterministic program-derived-address (PDA) and associated-token-address
 * (ATA) derivation for the Ponk Clouds program, ported byte-for-byte from
 * `dex-web/lib/ponkclouds.ts` so every seed matches the on-chain program
 * (`programs/ponk-clouds/src/lib.rs`).
 *
 * Seed layouts (all little-endian, all confirmed against the program's
 * Anchor account constraints):
 *   - pool:          [b"pool", mintX, mintY, binStep u16 LE]
 *   - bin_array:     [b"bin_array", pool, startBin i32 LE]
 *   - position:      [b"position", pool, owner, lower i32 LE]
 *   - pool_treasury: [b"pool_treasury", pool]
 *   - vault_x/y:     the pool PDA's associated token account for the mint
 *
 * Everything here is pure: no `Connection` is required and no I/O is
 * performed, so these helpers are safe to call in any environment and on any
 * code path (including hot UI render paths).
 */

import { PublicKey } from "@solana/web3.js";
import {
  PONK_CLOUDS_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BINS_PER_ARRAY,
} from "./constants";
import { u16le, i32le } from "./codec";

/** UTF-8 seed prefixes, matched byte-for-byte to the program's `b"..."` seeds. */
const SEED_POOL = Buffer.from("pool");
const SEED_BIN_ARRAY = Buffer.from("bin_array");
const SEED_POSITION = Buffer.from("position");
const SEED_POOL_TREASURY = Buffer.from("pool_treasury");

/**
 * Derive the pool PDA and its bump for a `(mintX, mintY, binStep)` triple.
 *
 * The pool is keyed by both mints and the bin step so multiple bin-step pools
 * can coexist for the same pair. `binStep` is encoded as a little-endian
 * `u16`, exactly matching the program's `bin_step_bps.to_le_bytes()` seed.
 * Mint order (X = base, Y = quote) is NOT canonicalized here; the caller picks
 * the orientation and the same orientation must be used everywhere downstream.
 *
 * @param mintX  Base-token mint.
 * @param mintY  Quote-token mint.
 * @param binStep  Bin step in basis points (u16 range).
 * @returns `[address, bump]`.
 */
export function poolPdaWithBump(
  mintX: PublicKey,
  mintY: PublicKey,
  binStep: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_POOL, mintX.toBuffer(), mintY.toBuffer(), u16le(binStep)],
    PONK_CLOUDS_PROGRAM_ID,
  );
}

/**
 * Derive the pool PDA for a `(mintX, mintY, binStep)` triple.
 *
 * Convenience wrapper over {@link poolPdaWithBump} that returns only the
 * address.
 */
export function poolPda(
  mintX: PublicKey,
  mintY: PublicKey,
  binStep: number,
): PublicKey {
  return poolPdaWithBump(mintX, mintY, binStep)[0];
}

/**
 * Derive the bin-array PDA for a pool and an array start bin id.
 *
 * `startBin` must be an array boundary (a multiple of {@link BINS_PER_ARRAY};
 * use {@link arrayStartForBin} to floor an arbitrary bin id onto it). It is
 * encoded as a little-endian `i32` so negative array starts derive correctly.
 *
 * @param pool  The pool PDA the array belongs to.
 * @param startBin  The first bin id covered by the array.
 */
export function binArrayPda(pool: PublicKey, startBin: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_BIN_ARRAY, pool.toBuffer(), i32le(startBin)],
    PONK_CLOUDS_PROGRAM_ID,
  )[0];
}

/**
 * Derive an owner's position PDA in a pool, keyed by its lower bin id.
 *
 * A wallet has at most one position per `(pool, lowerBinId)`. `lower` is the
 * inclusive lower bin of the position's range and is encoded as a
 * little-endian `i32`, matching the program's `lower_bin_id.to_le_bytes()`
 * seed.
 *
 * @param pool  The pool PDA the position belongs to.
 * @param owner  The position owner's wallet.
 * @param lower  The position's lower (inclusive) bin id.
 */
export function positionPda(
  pool: PublicKey,
  owner: PublicKey,
  lower: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_POSITION, pool.toBuffer(), owner.toBuffer(), i32le(lower)],
    PONK_CLOUDS_PROGRAM_ID,
  )[0];
}

/**
 * Derive the per-pool treasury-config PDA: seeds `[b"pool_treasury", pool]`.
 *
 * This is the account the platform's cut of the swap fee accrues into and the
 * config that records the treasury wallet + treasury fee bps. It is derived
 * from the pool alone, so the launch flow can initialize it in the same
 * transaction that creates the pool.
 *
 * @param pool  The pool PDA.
 */
export function poolTreasuryPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_POOL_TREASURY, pool.toBuffer()],
    PONK_CLOUDS_PROGRAM_ID,
  )[0];
}

/**
 * Derive the associated token account (ATA) for `owner` and `mint`.
 *
 * Uses the standard SPL Associated Token Account program seeds
 * `[owner, TOKEN_PROGRAM_ID, mint]`. This is the same derivation the program
 * relies on for both user and pool token accounts.
 *
 * @param owner  The account that owns the ATA.
 * @param mint   The token mint.
 */
export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Derive a pool's vault for a mint: the pool PDA's associated token account.
 *
 * The program's `vault_x` / `vault_y` are exactly the pool PDA's ATAs for
 * `mintX` / `mintY`, so this is `ata(pool, mint)` named for intent.
 *
 * @param pool  The pool PDA (the vault owner / signer).
 * @param mint  The vault's token mint.
 */
export function vaultPda(pool: PublicKey, mint: PublicKey): PublicKey {
  return ata(pool, mint);
}

/**
 * The array start bin id whose bin array contains `binId`.
 *
 * Floors `binId` onto a {@link BINS_PER_ARRAY} grid boundary using
 * `Math.floor`, which handles negative bin ids correctly (e.g. for
 * `BINS_PER_ARRAY === 70`, bin `-1` floors to `-70`, not `0`).
 *
 * @param binId  Any bin id.
 * @returns The first bin id of the array that holds `binId`.
 */
export function arrayStartForBin(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY) * BINS_PER_ARRAY;
}
