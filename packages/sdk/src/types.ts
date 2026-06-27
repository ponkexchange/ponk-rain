/**
 * Shared TypeScript types for the public `@ponkrain/sdk` surface.
 *
 * This module is the type backbone that keeps every other module's signatures
 * aligned: decoded on-chain account shapes (`CloudsPool`, `BinSlot`,
 * `DecodedBinArray`, `CloudsPosition`, `PoolTreasuryConfig`), pool display
 * metadata (`PoolInfo`), the liquidity-strategy union, deposit/swap preview
 * shapes, the range-plan shapes, classified on-chain activity, and the
 * `RainClient` option / parameter types.
 *
 * It is pure type information with no runtime code, so it can be imported from
 * any module (including hot paths) without side effects. `bigint` is used for
 * every on-chain `u64` / `u128` quantity (reserves, shares, fees, amounts);
 * plain `number` is used only for bin ids, basis points, and token decimals,
 * which all fit comfortably in a JS number.
 *
 * The field layouts mirror the program's `state.rs` and the decoders in
 * `pool.ts` / `position.ts`; do not reorder or retype fields here without
 * updating those decoders, since they are kept in lockstep by name.
 */

import type { Commitment, Connection, PublicKey } from "@solana/web3.js";

/**
 * A fully decoded Ponk Clouds `Pool` account.
 *
 * `address` is the pool PDA (not stored inside the account, supplied by the
 * decoder). All fee figures are basis points: `swapFeeBps` is OF the trade,
 * while `protocolFeeBps` is a share OF the swap fee (there is zero protocol fee
 * at the AMM level). `protocolFeeX` / `protocolFeeY` are the accrued, unclaimed
 * protocol fees in each mint's base units.
 */
export interface CloudsPool {
  /** The pool PDA address. */
  address: PublicKey;
  /** The pool authority: the only key that can set fees, pause, or claim. */
  authority: PublicKey;
  /** Base-token mint (X side). */
  mintX: PublicKey;
  /** Quote-token mint (Y side). */
  mintY: PublicKey;
  /** The pool's vault for `mintX` (the pool PDA's ATA for X). */
  vaultX: PublicKey;
  /** The pool's vault for `mintY` (the pool PDA's ATA for Y). */
  vaultY: PublicKey;
  /** Bin step in basis points; part of the pool PDA seed. */
  binStepBps: number;
  /** Swap fee in basis points OF the trade. */
  swapFeeBps: number;
  /** Protocol fee in basis points OF the swap fee. */
  protocolFeeBps: number;
  /** The current active bin id. */
  activeBinId: number;
  /** Whether swaps are paused. */
  paused: boolean;
  /** The pool PDA bump. */
  bump: number;
  /** Accrued, unclaimed protocol fee in `mintX` base units. */
  protocolFeeX: bigint;
  /** Accrued, unclaimed protocol fee in `mintY` base units. */
  protocolFeeY: bigint;
}

/**
 * Human-facing pool metadata for lists, pool pages, and charts.
 *
 * All addresses are base58 strings (UI-friendly). Symbols are resolved via an
 * optional caller-supplied resolver with an honest short-mint fallback; nothing
 * is fabricated. `binStep` is in basis points and is part of the pool identity.
 */
export interface PoolInfo {
  /** Pool PDA address, base58. */
  address: string;
  /** Display name, e.g. `"SOL / USDC"`. */
  name: string;
  /** Base-token mint, base58. */
  mintX: string;
  /** Base-token symbol (resolved or short-mint fallback). */
  symbolX: string;
  /** Base-token decimals. */
  decimalsX: number;
  /** Quote-token mint, base58. */
  mintY: string;
  /** Quote-token symbol (resolved or short-mint fallback). */
  symbolY: string;
  /** Quote-token decimals. */
  decimalsY: number;
  /** Bin step in basis points; part of the pool PDA seed. */
  binStep: number;
}

/**
 * A single bin's reserves and share supply, in raw base units / shares.
 *
 * Above the active bin a bin holds only `reserveX`; below it only `reserveY`;
 * the active bin can hold both. `totalShares` is the bin's outstanding LP share
 * supply, used to value and burn positions.
 */
export interface BinSlot {
  /** Base-unit reserve of token X. */
  reserveX: bigint;
  /** Base-unit reserve of token Y. */
  reserveY: bigint;
  /** Outstanding LP shares in this bin. */
  totalShares: bigint;
}

/**
 * A fully decoded `BinArray` account: its owning pool, the array's first bin
 * id, all {@link BinSlot}s in ascending order, and the PDA bump.
 */
export interface DecodedBinArray {
  /** The pool this array belongs to. */
  pool: PublicKey;
  /** The first (lowest) bin id covered by this array. */
  startBinId: number;
  /** The array's bins in ascending order. */
  slots: BinSlot[];
  /** The bin-array PDA bump. */
  bump: number;
}

/**
 * A fully decoded `Position` account.
 *
 * `address` is the position PDA, base58. The position covers the inclusive bin
 * range `[lowerBinId, upperBinId]`; `shares[i]` is the owner's share balance in
 * bin `lowerBinId + i`.
 */
export interface CloudsPosition {
  /** Position PDA address, base58. */
  address: string;
  /** The position owner's wallet. */
  owner: PublicKey;
  /** The pool the position belongs to. */
  pool: PublicKey;
  /** Inclusive lower bin id of the position's range; part of the PDA seed. */
  lowerBinId: number;
  /** Inclusive upper bin id of the position's range. */
  upperBinId: number;
  /** Per-bin share balances, indexed from `lowerBinId`. */
  shares: bigint[];
}

/**
 * A fully decoded `PoolTreasury` (platform-fee) config.
 *
 * `treasury` is the wallet the platform's cut OF the swap fee is paid to;
 * `treasuryFeeBps` is that cut in basis points OF the swap fee.
 * `treasuryFeeX` / `treasuryFeeY` are the accrued, unclaimed treasury fees in
 * each mint's base units.
 */
export interface PoolTreasuryConfig {
  /** The treasury-config PDA address. */
  address: PublicKey;
  /** The pool this treasury config belongs to. */
  pool: PublicKey;
  /** The treasury wallet that receives the platform cut. */
  treasury: PublicKey;
  /** Treasury cut in basis points OF the swap fee. */
  treasuryFeeBps: number;
  /** The treasury-config PDA bump. */
  bump: number;
  /** Accrued, unclaimed treasury fee in `mintX` base units. */
  treasuryFeeX: bigint;
  /** Accrued, unclaimed treasury fee in `mintY` base units. */
  treasuryFeeY: bigint;
}

/**
 * One bin in a {@link BinDistribution}, in human (decimal-adjusted) units for
 * chart rendering. `totalShares` stays raw so positions can be valued exactly.
 */
export interface ChartBin {
  /** The bin id. */
  binId: number;
  /** Human, decimal-adjusted price (quote per base) of this bin. */
  price: number;
  /** Reserve of token X in human units. */
  reserveX: number;
  /** Reserve of token Y in human units. */
  reserveY: number;
  /** Raw outstanding shares in this bin. */
  totalShares: bigint;
  /** Whether this is the pool's active bin. */
  isActive: boolean;
}

/**
 * The liquidity profile of a window of bins around the active bin, plus the
 * pool's fee/step parameters, ready for a liquidity chart.
 */
export interface BinDistribution {
  /** The pool's active bin id. */
  activeBinId: number;
  /** Bin step in basis points. */
  binStepBps: number;
  /** Swap fee in basis points OF the trade. */
  swapFeeBps: number;
  /** Protocol fee in basis points OF the swap fee. */
  protocolFeeBps: number;
  /** The bins in the window, ascending by bin id. */
  bins: ChartBin[];
}

/**
 * The exact outcome of a single-bin deposit preview: the shares the program
 * will mint and the reserves it will actually pull (the surplus on the
 * over-supplied side is refunded, so `usedX` / `usedY` may be below what was
 * offered). All in raw base units / shares. `sharesMinted` is `0n` when the
 * deposit would revert on-chain (dust seed below the minimum, or zero input).
 */
export interface DepositPreview {
  /** Shares the deposit mints. */
  sharesMinted: bigint;
  /** Base units of X actually consumed. */
  usedX: bigint;
  /** Base units of Y actually consumed. */
  usedY: bigint;
}

/**
 * The exact outcome of an off-chain swap quote, matching what the on-chain
 * `swap` returns. `amountInConsumed + amountInRemaining === amountIn`;
 * `amountInRemaining` is non-zero only when the loaded bins ran dry. `fee` is
 * the total swap fee; `protocolFee` and `treasuryFee` are the cuts withheld
 * from LP reserves (each a share OF the fee, never an extra trader charge), and
 * neither changes `amountOut`. All quantities are in raw base units.
 */
export interface SwapQuote {
  /** The requested gross input. */
  amountIn: bigint;
  /** Input the book actually consumed. */
  amountInConsumed: bigint;
  /** Input left unfilled when liquidity ran out (`0n` on a full fill). */
  amountInRemaining: bigint;
  /** Output sent to the trader. */
  amountOut: bigint;
  /** Total swap fee charged. */
  fee: bigint;
  /** Portion of `fee` taken as protocol revenue. */
  protocolFee: bigint;
  /** Portion of `fee` taken as treasury (platform) revenue. */
  treasuryFee: bigint;
  /** The bin id the walk ended on. */
  endBinId: number;
  /** How many bin arrays the walk spanned (informational). */
  binArraysTouched: number;
}

/**
 * A liquidity-distribution strategy for {@link RangePlan} planning.
 *
 *  - `spot`:   uniform weight across the range.
 *  - `curve`:  peaks nearest the active price and tapers toward the edges.
 *  - `bidask`: peaks at the edges of the range.
 *  - `full`:   uniform, intended for a wide range.
 */
export type Strategy = "spot" | "curve" | "bidask" | "full";

/**
 * One bin's planned deposit in a {@link RangePlan}: the X / Y base units to add
 * to `binId`. Bins above the active price carry only X, bins below carry only
 * Y; the active bin is included only for the single-bin (`spread === 0`) case.
 */
export interface RangePlanBin {
  /** The bin id this allocation targets. */
  binId: number;
  /** Base units of X to deposit into this bin. */
  amountX: bigint;
  /** Base units of Y to deposit into this bin. */
  amountY: bigint;
}

/**
 * A planned multi-bin deposit around the active bin: the inclusive bin range
 * `[lower, upper]` and the per-bin allocations (only the bins that receive
 * liquidity are listed).
 */
export interface RangePlan {
  /** Inclusive lower bin id of the planned range. */
  lower: number;
  /** Inclusive upper bin id of the planned range. */
  upper: number;
  /** The per-bin allocations (sparse: only funded bins appear). */
  bins: RangePlanBin[];
}

/**
 * The classification of a pool-touching transaction, inferred from how the
 * pool's two vaults moved: both up = `Add`, both down = `Withdraw`, opposite =
 * `Swap`, anything ambiguous = `Activity`.
 */
export type ActivityKind = "Add" | "Withdraw" | "Swap" | "Activity";

/**
 * A single classified, pool-touching transaction for an activity feed.
 * `deltaX` / `deltaY` are the net vault movements in human units (signed,
 * positive into the pool); `signer` is the fee payer (account index 0) or null
 * when the parsed transaction was unavailable.
 */
export interface PoolActivity {
  /** The transaction signature. */
  signature: string;
  /** Block time (unix seconds) or null if not yet available. */
  blockTime: number | null;
  /** Whether the transaction failed on-chain. */
  err: boolean;
  /** The inferred activity kind. */
  kind: ActivityKind;
  /** Net change in the X vault (human units, + into pool). */
  deltaX: number;
  /** Net change in the Y vault (human units, + into pool). */
  deltaY: number;
  /** The transaction's fee payer, base58, or null. */
  signer: string | null;
}

/**
 * Parameters to launch (rain) a new Ponk Clouds market.
 *
 * `authority` signs, pays, and becomes `pool.authority`. Mint order
 * (X = base, Y = quote) is NOT canonicalized and is part of the pool identity.
 * `binStep` is part of the pool PDA seed and must be `> 0`. `swapFeeBps` is the
 * trade fee (`<= MAX_SWAP_FEE_BPS`); `protocolFeeBps` is the creator's cut OF
 * the swap fee (`<= MAX_PROTOCOL_FEE_BPS`). `activeBinId` is the starting bin
 * (derive it from a human price via `computeActiveBinId`).
 */
export interface RainParams {
  /** The launch authority: signer, payer, and recorded `pool.authority`. */
  authority: PublicKey;
  /** Base-token mint (X side). */
  mintX: PublicKey;
  /** Quote-token mint (Y side). */
  mintY: PublicKey;
  /** Bin step in basis points; part of the pool PDA seed. Must be `> 0`. */
  binStep: number;
  /** Swap fee in basis points OF the trade. `0..=MAX_SWAP_FEE_BPS`. */
  swapFeeBps: number;
  /** Protocol fee in basis points OF the swap fee. `0..=MAX_PROTOCOL_FEE_BPS`. */
  protocolFeeBps: number;
  /** The starting active bin id. */
  activeBinId: number;
}

/**
 * Parameters to build a Ponk Clouds `swap` instruction.
 *
 * `startBins[0]` is the active bin's array; the remaining entries are the
 * contiguous neighbour arrays in travel order (see `swapStartBins`). The
 * array count must be `1..=MAX_SWAP_BIN_ARRAYS`. `xForY = true` sells X for Y
 * and walks the price DOWN; `false` sells Y for X and walks UP. `amountIn` is
 * the gross input and `minOut` the slippage floor, both in base units.
 */
export interface SwapParams {
  /** The trader's wallet (signer). */
  user: PublicKey;
  /** Base-token mint (X side). */
  mintX: PublicKey;
  /** Quote-token mint (Y side). */
  mintY: PublicKey;
  /** Bin step in basis points; selects the pool. */
  binStep: number;
  /** Contiguous bin-array start ids in travel order; `[0]` = active array. */
  startBins: number[];
  /** Gross input in base units. */
  amountIn: bigint;
  /** Minimum acceptable output in base units (slippage floor). */
  minOut: bigint;
  /** Swap direction: true = sell X for Y (walk down), false = sell Y for X. */
  xForY: boolean;
}

/**
 * Construction options for {@link RainClient}.
 *
 * `connection` is required. `programId` overrides the default Ponk Clouds
 * program id (the only supported way to point the SDK at a different
 * deployment, e.g. a local validator); it is read-only metadata and does not
 * re-key the PDA-derivation helpers, which are bound to the compiled default,
 * so override it only for a deployment that shares the canonical program id.
 * `commitment` defaults to `"confirmed"`.
 */
export interface RainClientOptions {
  /** The Solana RPC connection the client reads/sends through. */
  connection: Connection;
  /** Optional override of the Ponk Clouds program id. */
  programId?: PublicKey;
  /** Optional read/confirm commitment (defaults to `"confirmed"`). */
  commitment?: Commitment;
}
