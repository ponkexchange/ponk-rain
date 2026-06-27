/**
 * Ponk Rain launch module barrel.
 *
 * Re-exports the market-launch transaction builders and the high-level
 * {@link createMarket} planner, so consumers import the whole Rain surface from
 * one path. This is the directory form of the design spec's `rain.ts`; it
 * provides every `rain` export (initializePoolIx, createPoolIxs,
 * initPoolTreasuryIx, computeActiveBinId, validateRainParams) plus the
 * bin-array launch helpers and the price-first {@link createMarket} builder.
 */

export * from "./createPool.js";
