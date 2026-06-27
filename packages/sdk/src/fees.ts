/**
 * Authority-only fee-claim transactions for the Ponk Clouds program, plus
 * reads of the currently accrued amounts.
 *
 * Two fee accumulators exist per pool:
 *
 *  - The PROTOCOL fee accrues on the {@link CloudsPool} itself
 *    (`protocol_fee_x` / `protocol_fee_y`). It is the protocol's cut of the
 *    swap fee, withheld in the input token on every swap. The pool authority
 *    sweeps it to its own token accounts with `claim_protocol_fees`.
 *
 *  - The TREASURY (platform) fee accrues on the per-pool `PoolTreasury` PDA
 *    (`treasury_fee_x` / `treasury_fee_y`). It only ever moves to the wallet
 *    recorded in that config (`PoolTreasury::treasury`); the pool authority
 *    signs `claim_treasury_fees`, but the program's `ClaimTreasuryFees`
 *    constraints force the destination token accounts to be owned by the
 *    configured treasury, so the authority can route this cut nowhere else.
 *
 * Both claims take NO instruction data beyond the 8-byte Anchor discriminator.
 * The account orders below are FROZEN to the program's `ClaimProtocolFees` and
 * `ClaimTreasuryFees` accounts structs (ponk-clouds/programs/ponk-clouds/src/
 * lib.rs); changing the order or signer/writable flags breaks the on-chain
 * deserialization. Both transfers are signed by the pool PDA on-chain, so the
 * claimer only needs to sign as `authority` (and, for the protocol claim, hold
 * or create the destination ATAs first).
 *
 * The vaults are the pool PDA's associated token accounts for `mintX` / `mintY`
 * (i.e. `pool.vault_x` / `pool.vault_y`), derived deterministically via
 * {@link vaultPda} rather than read from chain, so these builders are pure.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

import { PONK_CLOUDS_PROGRAM_ID, TOKEN_PROGRAM_ID, DISCRIMINATORS } from "./constants";
import { poolPda, poolTreasuryPda, vaultPda, ata } from "./pda";
import { concatBytes } from "./codec";
import { fetchPool, fetchPoolTreasury } from "./pool";

/** Build an `AccountMeta` succinctly (matches the program's account order). */
function meta(
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean } {
  return { pubkey, isSigner, isWritable };
}

/**
 * Build the Ponk Clouds `claim_protocol_fees` instruction.
 *
 * Authority-only: sweeps the pool's accrued protocol fees (`protocol_fee_x` /
 * `protocol_fee_y`) from the pool vaults into the authority's own token
 * accounts, then zeroes the accumulators on-chain. The transfer is signed by
 * the pool PDA; the caller signs only as `authority`.
 *
 * Account order is FROZEN to the program's `ClaimProtocolFees` struct:
 *   [authority(signer), pool(mut), vaultX(mut), vaultY(mut),
 *    authorityTokenX(mut), authorityTokenY(mut), tokenProgram]
 *
 * The two destination accounts are the authority's ATAs for `mintX` / `mintY`
 * and MUST already exist (the program constrains them as live `TokenAccount`s);
 * create them idempotently first if unsure. Data is the bare discriminator.
 *
 * @param args.authority  The pool authority (signer and fee recipient).
 * @param args.mintX  Base-token mint (X side of the pool).
 * @param args.mintY  Quote-token mint (Y side of the pool).
 * @param args.binStep  Pool bin step in bps (part of the pool PDA seed).
 */
export function claimProtocolFeesIx(args: {
  authority: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  binStep: number;
}): TransactionInstruction {
  const pool = poolPda(args.mintX, args.mintY, args.binStep);
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(args.authority, true, true),
      meta(pool, false, true),
      meta(vaultPda(pool, args.mintX), false, true),
      meta(vaultPda(pool, args.mintY), false, true),
      meta(ata(args.authority, args.mintX), false, true),
      meta(ata(args.authority, args.mintY), false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: concatBytes([DISCRIMINATORS.claimProtocolFees]),
  });
}

/**
 * Build the Ponk Clouds `claim_treasury_fees` instruction.
 *
 * Authority-only: sweeps the per-pool `PoolTreasury` PDA's accrued treasury
 * (platform) fees (`treasury_fee_x` / `treasury_fee_y`) from the pool vaults
 * into the CONFIGURED treasury wallet's token accounts, then zeroes the
 * accumulators on-chain. The pool authority signs, but the program forces the
 * destinations to be ATAs owned by `PoolTreasury::treasury`, so the authority
 * cannot redirect the platform cut.
 *
 * Account order is FROZEN to the program's `ClaimTreasuryFees` struct:
 *   [authority(signer), pool(mut), poolTreasury(mut), vaultX(mut), vaultY(mut),
 *    treasuryTokenX(mut), treasuryTokenY(mut), tokenProgram]
 *
 * The destination accounts are the treasury wallet's ATAs for `mintX` /
 * `mintY` and MUST already exist; create them idempotently first if unsure.
 * Data is the bare discriminator.
 *
 * @param args.authority  The pool authority (signer).
 * @param args.mintX  Base-token mint (X side of the pool).
 * @param args.mintY  Quote-token mint (Y side of the pool).
 * @param args.binStep  Pool bin step in bps (part of the pool PDA seed).
 * @param args.treasury  The configured treasury wallet (owner of the
 *   destination token accounts). Must equal `PoolTreasury::treasury`, otherwise
 *   the program's `token::authority` constraint rejects the claim on-chain.
 */
export function claimTreasuryFeesIx(args: {
  authority: PublicKey;
  mintX: PublicKey;
  mintY: PublicKey;
  binStep: number;
  treasury: PublicKey;
}): TransactionInstruction {
  const pool = poolPda(args.mintX, args.mintY, args.binStep);
  return new TransactionInstruction({
    programId: PONK_CLOUDS_PROGRAM_ID,
    keys: [
      meta(args.authority, true, true),
      meta(pool, false, true),
      meta(poolTreasuryPda(pool), false, true),
      meta(vaultPda(pool, args.mintX), false, true),
      meta(vaultPda(pool, args.mintY), false, true),
      meta(ata(args.treasury, args.mintX), false, true),
      meta(ata(args.treasury, args.mintY), false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: concatBytes([DISCRIMINATORS.claimTreasuryFees]),
  });
}

/**
 * Read the protocol fees currently accrued on a pool, in base units of each
 * side. These are the exact amounts a `claim_protocol_fees` would sweep right
 * now (the program transfers `protocol_fee_x` / `protocol_fee_y` then zeroes
 * them). Returns null when the pool does not exist at this RPC, so callers can
 * render `--` rather than a fabricated zero.
 *
 * @param conn  An RPC connection.
 * @param mintX  Base-token mint (X side of the pool).
 * @param mintY  Quote-token mint (Y side of the pool).
 * @param binStep  Pool bin step in bps.
 * @returns `{ feeX, feeY }` in base units, or null if the pool is absent.
 */
export async function readAccruedProtocolFees(
  conn: Connection,
  mintX: PublicKey,
  mintY: PublicKey,
  binStep: number,
): Promise<{ feeX: bigint; feeY: bigint } | null> {
  const pool = await fetchPool(conn, mintX, mintY, binStep);
  if (!pool) return null;
  return { feeX: pool.protocolFeeX, feeY: pool.protocolFeeY };
}

/**
 * Read the treasury (platform) fees currently accrued on a pool's
 * `PoolTreasury` PDA, in base units of each side. These are the exact amounts a
 * `claim_treasury_fees` would sweep right now. Returns null when the per-pool
 * treasury config has not been created (the platform cut is then zero and there
 * is nothing to claim) or is unreadable, so callers can render `--`.
 *
 * @param conn  An RPC connection.
 * @param pool  The pool PDA whose treasury config to read.
 * @returns `{ feeX, feeY }` in base units, or null if no treasury config exists.
 */
export async function readAccruedTreasuryFees(
  conn: Connection,
  pool: PublicKey,
): Promise<{ feeX: bigint; feeY: bigint } | null> {
  const cfg = await fetchPoolTreasury(conn, pool);
  if (!cfg) return null;
  return { feeX: cfg.treasuryFeeX, feeY: cfg.treasuryFeeY };
}
