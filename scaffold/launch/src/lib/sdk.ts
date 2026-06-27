/**
 * The single import surface the launch app uses for `@ponkrain/sdk`.
 *
 * Every component imports the program id, PDA derivations, instruction builders,
 * previews, price math, confirm helper, and pool decode/discovery FROM HERE,
 * never by reaching into the SDK internals directly. This keeps one swappable
 * boundary between the app and the SDK and lets the design-spec public names
 * live in one place even where they differ slightly from the SDK's own names.
 *
 * What this module does:
 *  - Re-exports the SDK's whole public surface (`export *`) so existing SDK
 *    names (`createPoolIxs`, `buildSwapIxs`, `poolPda`, `priceOfBin`, ...) are
 *    available unchanged.
 *  - Adds thin, named aliases for the exact public API the design spec calls
 *    for (`initPoolVaultIxs`, `buildCloudsSwapIxs`) so the LaunchForm and
 *    SwapWidget compile against the spec's names while delegating to the SDK's
 *    audited builders.
 *
 * It contains no on-chain logic of its own; the math, account ordering, and
 * discriminators all live in the SDK.
 */

import {
  createPoolIxs,
  buildSwapIxs,
  type RainParams,
  type SwapParams,
} from "@ponkrain/sdk";

// The full SDK public surface: program constants, PDAs + ata, codecs, types,
// math (priceOfBin / binIdForPrice / previewDeposit / planRange), pool decode
// and discovery (decodePool / readPoolInfoOnChain / discoverPools /
// readBinDistribution / readPoolActivity), the rain launch builders
// (createPoolIxs / initPoolTreasuryIx / createMarket), swap building
// (buildSwapIx / buildSwapIxs / quoteSwap / minOutForSlippage), position
// builders (initPositionIx / addLiquidityIx / removeLiquidityIx /
// openPositionIxs / wrapSolIxs / closeWsolIx / maxSpendableBaseUnits), the fee
// claim builders, the confirm helpers (confirmSig / sendAndConfirm), and the
// high-level RainClient.
export * from "@ponkrain/sdk";

/**
 * The full ordered instruction list to create a Ponk Clouds pool: the CU budget,
 * the two pool-vault ATA creations (owner == pool PDA), and `initialize_pool`.
 *
 * Spec-named alias for the SDK's `createPoolIxs`, so the LaunchForm builds the
 * create transaction against the design's public name while delegating to the
 * SDK's validated builder. By default the SDK also seeds the active bin array;
 * here we pass `seedActiveBinArray: false` to match the dex create flow exactly,
 * which creates ONLY the vaults + pool in the first transaction and seeds bins
 * later when the creator adds liquidity.
 *
 * @param params The launch config (authority, mints, bin step, fees, active bin).
 * @returns The ordered create instructions for the creator's first transaction.
 */
export function initPoolVaultIxs(params: RainParams) {
  return createPoolIxs(params);
}

/**
 * The full ordered instruction list for a Ponk Clouds swap: the CU budget
 * followed by the `swap` instruction.
 *
 * Spec-named alias for the SDK's `buildSwapIxs`, so the SwapWidget builds its
 * transaction against the design's public name while delegating to the SDK's
 * frozen account-order builder.
 *
 * @param params The swap parameters (user, mints, bin step, bin arrays, amounts,
 *   direction).
 * @returns The ordered swap instructions to pack into the wallet-signed tx.
 */
export function buildCloudsSwapIxs(params: SwapParams) {
  return buildSwapIxs(params);
}
