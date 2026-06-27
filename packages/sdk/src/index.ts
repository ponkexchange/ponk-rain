/**
 * The public barrel for `@ponkrain/sdk`.
 *
 * This is the single import surface external developers and the scaffold app
 * consume: `import { RainClient, ... } from "@ponkrain/sdk"`. It re-exports every
 * public symbol from the constants, IDL, PDA, codec, types, math, pool, rain,
 * swap, position, fees, and confirm modules, plus the {@link RainClient} as both
 * a named export and the default export.
 *
 * It contains no logic of its own; it only wires the modules together. The
 * directory layout differs slightly from a flat one-file-per-module shape (the
 * IDL lives under `./idl`, the launch builders under `./rain`, and the math
 * primitives under `./math`), but every public name the design specifies is
 * surfaced here at the top level.
 */

// Program constants, addresses, fee caps, CU limits, account sizes, and the
// Anchor instruction/account discriminators.
export * from "./constants";

// Version / build metadata (dependency-free).
export * from "./version";

// The Anchor IDL data object, the custom-error-code map, and the error
// explainer. (Lives under ./idl; surfaced here per the design spec's `./idl`.)
export * from "./idl/ponk_clouds";

// Deterministic PDA + ATA derivation and the bin-array grid helper.
export * from "./pda";

// Low-level little-endian byte codecs and human/base-unit conversions.
export * from "./codec";

// Shared public type backbone (decoded account shapes, params, results).
export * from "./types";

// Exact, on-chain-faithful math: bin pricing, swap, and liquidity primitives,
// plus the range planner. (Barrel over ./math/price, ./math/swap, ./math/liquidity.)
export * from "./math";

// Pool state reading, decoding, discovery, bin distribution, and activity.
export * from "./pool";

// Ponk Rain launch: market-creation transaction builders and the price-first
// planner. (Barrel over ./rain/createPool; surfaced here per the spec's `./rain`.)
export * from "./rain";

// Swap transaction building and exact off-chain quoting.
export * from "./swap";

// Open / fund / close LP positions, wSOL helpers, and position discovery.
export * from "./position";

// Authority-only fee-claim builders and accrued-fee reads.
export * from "./fees";

// Send / confirm helpers (status-polling confirmation, size-based packing).
export * from "./confirm";

// The high-level client.
export * from "./client";

// The client is also the default export, so `import RainClient from
// "@ponkrain/sdk"` works alongside the named import.
export { RainClient as default } from "./client";
