/**
 * {@link RainClient}: the high-level, batteries-included entry point to the
 * Ponk Clouds AMM.
 *
 * It wraps a `Connection` (plus an optional program-id override and read/confirm
 * commitment) and exposes ergonomic methods for the full market lifecycle:
 * launch a market (`rain`), swap, open / add / remove / close LP positions,
 * claim protocol and treasury fees, read and discover pools, read the bin
 * distribution, positions, and activity, and quote swaps and deposits.
 *
 * Custody stays with the caller: every MUTATING method returns the built
 * `TransactionInstruction[]` (and the derived addresses) without signing or
 * sending. Only {@link RainClient.sendAndConfirm} touches the wire, and it does
 * so through a caller-provided signer callback, so the client never holds a key.
 *
 * Read methods delegate to `pool.ts` / `position.ts` / `fees.ts`; transaction
 * builders delegate to `rain` / `swap.ts` / `position.ts` / `fees.ts`; math
 * helpers delegate to `math/*`. This is the surface most app developers use; the
 * lower-level functions remain individually importable from the barrel for
 * advanced callers.
 */

import type {
  Commitment,
  Connection,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { PONK_CLOUDS_PROGRAM_ID } from "./constants";
import { poolPda } from "./pda";
import type {
  BinDistribution,
  CloudsPool,
  CloudsPosition,
  DepositPreview,
  PoolActivity,
  PoolInfo,
  RainClientOptions,
  RainParams,
  Strategy,
  SwapQuote,
} from "./types";
import {
  discoverPools,
  fetchPool,
  fetchPoolByAddress,
  readBinDistribution,
  readPoolActivity,
  readPoolInfoOnChain,
} from "./pool";
import {
  createPoolIxs,
  initPoolTreasuryIx,
} from "./rain/createPool";
import {
  buildSwapIxs,
  minOutForSlippage,
  quoteSwap,
  swapStartBins,
} from "./swap";
import {
  closePositionIx,
  initBinArrayIx,
  initPositionIx,
  loadDepositContext,
  openPositionIxs,
  readPositions,
  removeLiquidityIx,
} from "./position";
import {
  claimProtocolFeesIx,
  claimTreasuryFeesIx,
} from "./fees";
import { previewDeposit, planRange, type BinLiquidity } from "./math/liquidity";
import { sendAndConfirm as sendAndConfirmTx } from "./confirm";

/**
 * High-level Ponk Clouds / Ponk Rain client.
 *
 * Construct it once with an RPC {@link RainClientOptions.connection}; all methods
 * reuse that connection. The {@link RainClient.programId} is the default Ponk
 * Clouds program id unless overridden in the options (the override is metadata
 * for callers that target a deployment sharing the canonical program id; PDA
 * derivation is bound to the compiled default).
 *
 * @example
 * const client = new RainClient({ connection });
 * const { ixs, treasuryIx, pool } = client.rain(rainParams);
 * // sign + send ixs (and treasuryIx) however you like, or use sendAndConfirm.
 */
export class RainClient {
  /** The RPC connection all reads and sends go through. */
  readonly connection: Connection;
  /** The Ponk Clouds program id this client targets. */
  readonly programId: PublicKey;
  /** The read/confirm commitment used for connection-level reads. */
  readonly commitment: Commitment;

  /**
   * @param opts  The connection and optional program-id / commitment overrides.
   */
  constructor(opts: RainClientOptions) {
    this.connection = opts.connection;
    this.programId = opts.programId ?? PONK_CLOUDS_PROGRAM_ID;
    this.commitment = opts.commitment ?? "confirmed";
  }

  // -------------------------------------------------------------------------
  // Addresses.
  // -------------------------------------------------------------------------

  /**
   * Derive the pool PDA for a `(mintX, mintY, binStep)` triple. Mint order is
   * NOT canonicalized; pass `mintX` = base, `mintY` = quote consistently.
   */
  poolAddress(mintX: PublicKey, mintY: PublicKey, binStep: number): PublicKey {
    return poolPda(mintX, mintY, binStep);
  }

  // -------------------------------------------------------------------------
  // Launch (rain).
  // -------------------------------------------------------------------------

  /**
   * Build everything to launch (rain) a new Ponk Clouds market.
   *
   * Returns the pool-creation bundle (`ixs`: CU budget + the two pool-vault ATA
   * creations + `initialize_pool`), the SEPARATE treasury-init instruction
   * (`treasuryIx`), and the derived `pool` address. The treasury ix is kept
   * apart so a treasury hiccup can never undo the (more important) pool
   * creation; append it to the same transaction only if you want strict
   * atomicity. Validates the fee caps and bin step locally first (throws on a
   * bad config). Nothing is signed or sent.
   */
  rain(params: RainParams): {
    ixs: TransactionInstruction[];
    treasuryIx: TransactionInstruction;
    pool: PublicKey;
  } {
    const pool = poolPda(params.mintX, params.mintY, params.binStep);
    return {
      ixs: createPoolIxs(params),
      treasuryIx: initPoolTreasuryIx({ authority: params.authority, pool }),
      pool,
    };
  }

  // -------------------------------------------------------------------------
  // Pool reads + discovery.
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode the pool for a `(mintX, mintY, binStep)` triple, or null
   * when no such pool exists at this RPC.
   */
  getPool(
    mintX: PublicKey,
    mintY: PublicKey,
    binStep: number,
  ): Promise<CloudsPool | null> {
    return fetchPool(this.connection, mintX, mintY, binStep);
  }

  /**
   * Fetch and decode the pool at an explicit address, or null when the account
   * is absent / not a Clouds pool.
   */
  getPoolByAddress(pool: PublicKey): Promise<CloudsPool | null> {
    return fetchPoolByAddress(this.connection, pool);
  }

  /**
   * Discover every Ponk Clouds pool on chain as display-ready {@link PoolInfo}.
   * Symbols come from the optional `resolveSymbol` callback with an honest
   * short-mint fallback. Returns `[]` on RPC failure so callers can degrade.
   */
  discoverPools(opts?: {
    resolveSymbol?: (mint: string) => string | null;
  }): Promise<PoolInfo[]> {
    return discoverPools(this.connection, opts);
  }

  /**
   * Resolve a pool's display metadata directly from chain by address, or null
   * when the address is not a Clouds pool. Symbols use the optional resolver
   * with a short-mint fallback.
   */
  getPoolInfo(
    address: string,
    opts?: { resolveSymbol?: (mint: string) => string | null },
  ): Promise<PoolInfo | null> {
    return readPoolInfoOnChain(this.connection, address, opts);
  }

  /**
   * Read the bin liquidity distribution in `[active - radius, active + radius]`
   * in human units, for a liquidity chart. Empty bins read as zero.
   */
  getBinDistribution(info: PoolInfo, radius?: number): Promise<BinDistribution> {
    return readBinDistribution(this.connection, info, radius);
  }

  /**
   * Read recent pool-touching transactions, classified by net vault movement
   * (Add / Withdraw / Swap / Activity), with signed human-unit deltas.
   */
  getActivity(info: PoolInfo, limit?: number): Promise<PoolActivity[]> {
    return readPoolActivity(this.connection, info, limit);
  }

  // -------------------------------------------------------------------------
  // Swap.
  // -------------------------------------------------------------------------

  /**
   * Quote a swap off-chain so the result equals what the program would return.
   * Reads the pool and the bin arrays the swap can walk and runs the exact
   * cross-bin math. `maxBinArrays` is clamped to the on-chain array cap.
   */
  quoteSwap(args: {
    mintX: PublicKey;
    mintY: PublicKey;
    binStep: number;
    amountIn: bigint;
    xForY: boolean;
    maxBinArrays?: number;
  }): Promise<SwapQuote> {
    return quoteSwap(this.connection, args);
  }

  /**
   * Build the full swap instruction list (CU budget + `swap`) and the
   * slippage-floored `min_out`.
   *
   * A {@link SwapQuote} may be supplied (e.g. one already shown to the user) to
   * avoid a second RPC round-trip; otherwise the swap is quoted here first. The
   * bin arrays the swap names are derived from the quote's active-bin walk (the
   * arrays actually touched, capped at the on-chain limit), and `min_out` is
   * `quotedOut * (1 - slippageBps/1e4)` floored. Nothing is signed or sent.
   */
  async swap(args: {
    user: PublicKey;
    mintX: PublicKey;
    mintY: PublicKey;
    binStep: number;
    amountIn: bigint;
    xForY: boolean;
    slippageBps: number;
    quote?: SwapQuote;
  }): Promise<{ ixs: TransactionInstruction[]; minOut: bigint }> {
    const quote =
      args.quote ??
      (await quoteSwap(this.connection, {
        mintX: args.mintX,
        mintY: args.mintY,
        binStep: args.binStep,
        amountIn: args.amountIn,
        xForY: args.xForY,
      }));
    const minOut = minOutForSlippage(quote.amountOut, args.slippageBps);
    const pool = await fetchPool(
      this.connection,
      args.mintX,
      args.mintY,
      args.binStep,
    );
    if (!pool) throw new Error("Ponk Clouds pool not found at this RPC");
    // Name the active bin's array plus the neighbours the quote actually walked
    // (bounded by the on-chain array cap inside swapStartBins/buildSwapIx).
    const startBins = swapStartBins(
      pool.activeBinId,
      Math.max(1, quote.binArraysTouched),
      args.xForY,
    );
    const ixs = buildSwapIxs({
      user: args.user,
      mintX: args.mintX,
      mintY: args.mintY,
      binStep: args.binStep,
      startBins,
      amountIn: args.amountIn,
      minOut,
      xForY: args.xForY,
    });
    return { ixs, minOut };
  }

  // -------------------------------------------------------------------------
  // Liquidity previews + planning (pure).
  // -------------------------------------------------------------------------

  /**
   * Preview a single-bin deposit: the shares minted and reserves actually
   * pulled (surplus on the over-supplied side is refunded). `sharesMinted` is
   * `0n` when the deposit would revert on-chain. Pure; no RPC.
   */
  previewDeposit(bin: BinLiquidity, addX: bigint, addY: bigint): DepositPreview {
    return previewDeposit(bin, addX, addY);
  }

  /**
   * Plan a multi-bin deposit around the active bin for a {@link Strategy}: base
   * (X) above the active price, quote (Y) below, the active bin skipped unless
   * `spread === 0`. Pure; no RPC.
   */
  planRange(
    activeBin: number,
    spread: number,
    totalX: bigint,
    totalY: bigint,
    strategy: Strategy,
  ) {
    return planRange(activeBin, spread, totalX, totalY, strategy);
  }

  // -------------------------------------------------------------------------
  // Positions.
  // -------------------------------------------------------------------------

  /**
   * Read the pool, the target bin's slot, and whether the bin array and the
   * single-bin position already exist, so a caller knows exactly which init
   * instructions {@link RainClient.addLiquidity} should prepend.
   */
  loadDepositContext(
    mintX: PublicKey,
    mintY: PublicKey,
    binStep: number,
    owner: PublicKey,
    binId: number,
  ): Promise<{
    pool: CloudsPool;
    slot: { reserveX: bigint; reserveY: bigint; totalShares: bigint };
    startBin: number;
    binArrayExists: boolean;
    positionExists: boolean;
  }> {
    return loadDepositContext(
      this.connection,
      mintX,
      mintY,
      binStep,
      owner,
      binId,
    );
  }

  /**
   * Assemble the full single-bin add-liquidity bundle, prepending exactly the
   * init instructions the deposit needs:
   * `[initialize_bin_array?, initialize_position?, add_liquidity]`. Pass the
   * existence flags straight from {@link RainClient.loadDepositContext}. Nothing
   * is signed or sent.
   */
  addLiquidity(ctx: {
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
    return openPositionIxs(ctx);
  }

  /**
   * Build a `remove_liquidity` instruction: burn `shares` from one bin of a
   * position, returning the proportional reserves to the owner. Nothing is
   * signed or sent.
   */
  removeLiquidity(args: {
    owner: PublicKey;
    mintX: PublicKey;
    mintY: PublicKey;
    binStep: number;
    startBin: number;
    lower: number;
    binId: number;
    shares: bigint;
  }): TransactionInstruction {
    return removeLiquidityIx(args);
  }

  /**
   * Build a `close_position` instruction: close a fully-withdrawn position and
   * refund its rent to the owner. Reverts on-chain if any bin still holds
   * shares. Nothing is signed or sent.
   */
  closePosition(
    owner: PublicKey,
    pool: PublicKey,
    lower: number,
  ): TransactionInstruction {
    return closePositionIx(owner, pool, lower);
  }

  /**
   * Build a single-bin `initialize_bin_array` instruction (allocate the
   * 70-bin window holding `startBin`). `startBin` must be grid-aligned.
   */
  initBinArray(
    payer: PublicKey,
    pool: PublicKey,
    startBin: number,
  ): TransactionInstruction {
    return initBinArrayIx(payer, pool, startBin);
  }

  /**
   * Build an `initialize_position` instruction (open an empty position over the
   * inclusive bin range `[lower, upper]`).
   */
  initPosition(
    owner: PublicKey,
    pool: PublicKey,
    lower: number,
    upper: number,
  ): TransactionInstruction {
    return initPositionIx(owner, pool, lower, upper);
  }

  /**
   * Discover all of `owner`'s (non-empty) positions in the pool for `info`,
   * sorted by lower bin id.
   */
  getPositions(info: PoolInfo, owner: PublicKey): Promise<CloudsPosition[]> {
    return readPositions(this.connection, info, owner);
  }

  // -------------------------------------------------------------------------
  // Fee claims (authority only).
  // -------------------------------------------------------------------------

  /**
   * Build a `claim_protocol_fees` instruction: sweep the pool's accrued
   * protocol fees into the authority's own token accounts (which must already
   * exist). Authority-only. Nothing is signed or sent.
   */
  claimProtocolFees(args: {
    authority: PublicKey;
    mintX: PublicKey;
    mintY: PublicKey;
    binStep: number;
  }): TransactionInstruction {
    return claimProtocolFeesIx(args);
  }

  /**
   * Build a `claim_treasury_fees` instruction: sweep the per-pool treasury's
   * accrued platform fees into the CONFIGURED treasury wallet's token accounts.
   * The authority signs but cannot redirect the destination. Nothing is signed
   * or sent.
   */
  claimTreasuryFees(args: {
    authority: PublicKey;
    mintX: PublicKey;
    mintY: PublicKey;
    binStep: number;
    treasury: PublicKey;
  }): TransactionInstruction {
    return claimTreasuryFeesIx(args);
  }

  // -------------------------------------------------------------------------
  // Send + confirm.
  // -------------------------------------------------------------------------

  /**
   * Sign (via the caller-provided `sign` callback), send, and confirm a
   * transaction. The blockhash and fee payer are set by the underlying helper
   * when unset, the raw transaction is broadcast, and confirmation polls the
   * signature status (rather than trusting a possibly-dropped WebSocket
   * notification). Returns the transaction signature.
   *
   * The `sign` callback owns key custody: it receives the prepared transaction
   * and must return it signed (e.g. via a wallet adapter).
   */
  sendAndConfirm(
    tx: Transaction,
    sign: (tx: Transaction) => Promise<Transaction>,
  ): Promise<string> {
    return sendAndConfirmTx(this.connection, tx, sign);
  }
}
