# `@ponkrain/sdk` reference

The complete public API of the Ponk Rain SDK: every module, every exported
symbol, its signature, and a runnable example. The SDK is a thin, env-agnostic
TypeScript wrapper over the deployed **Ponk Clouds** program
(`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`), a bin-based DLMM AMM with
**zero protocol fee at the AMM level**.

> ponk.exchange was assessed by zauth (Vector) on 29 September 2026: a deep scan
> across 51 endpoints, 5 subdomains and 58 input vectors, every finding verified
> by browser-based proof of concept. 12 findings, no critical. The report is
> published in full at https://ponk.exchange/docs/audits
>
> Test against a local validator or devnet before you deploy capital, as you
> would with any on-chain program.

Everything is built on raw [`@solana/web3.js`](https://solana-labs.github.io/solana-web3.js/)
(`^1.95.3`) with no Anchor runtime dependency, so transaction building works in
any environment (browser, Node, edge). All on-chain `u64`/`u128` quantities are
`bigint`; plain `number` is used only for bin ids, basis points, and token
decimals. Functions never auto-sign: builders return `TransactionInstruction[]`
(or a `Transaction`) and the caller owns key custody.

## Contents

- [Install and import](#install-and-import)
- [Quick start](#quick-start)
- [`RainClient` (high-level entry point)](#rainclient-high-level-entry-point)
- [Module: `constants`](#module-constants)
- [Module: `version`](#module-version)
- [Module: `idl`](#module-idl)
- [Module: `pda`](#module-pda)
- [Module: `codec`](#module-codec)
- [Module: `types`](#module-types)
- [Module: `math/price`](#module-mathprice)
- [Module: `math/swap`](#module-mathswap)
- [Module: `math/liquidity`](#module-mathliquidity)
- [Module: `pool`](#module-pool)
- [Module: `rain`](#module-rain)
- [Module: `swap`](#module-swap)
- [Module: `position`](#module-position)
- [Module: `fees`](#module-fees)
- [Module: `confirm`](#module-confirm)
- [Conventions and guarantees](#conventions-and-guarantees)

---

## Install and import

```bash
pnpm add @ponkrain/sdk @solana/web3.js
```

The package is ESM, strict TypeScript. The barrel re-exports every public symbol
from all modules, and `RainClient` is also the default export:

```ts
import {
  RainClient,
  poolPda,
  fetchPool,
  quoteSwap,
  priceOfBin,
  PONK_CLOUDS_PROGRAM_ID,
} from "@ponkrain/sdk";

// The default export is RainClient.
import RainClient from "@ponkrain/sdk";
```

You can import a single primitive or build the whole flow off `RainClient`. The
two are interchangeable: the client's methods delegate to the same module
functions documented below.

---

## Quick start

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { RainClient, NATIVE_MINT } from "@ponkrain/sdk";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const client = new RainClient({ connection });

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const binStep = 4;

// 1. Read a pool.
const pool = await client.getPool(NATIVE_MINT, USDC, binStep);

// 2. Quote a swap (exact, off-chain, matches on-chain output).
const quote = await client.quoteSwap({
  mintX: NATIVE_MINT,
  mintY: USDC,
  binStep,
  amountIn: 1_000_000_000n, // 1 SOL
  xForY: true,
});

// 3. Build a swap with a 50 bps slippage guard (caller signs + sends).
const { ixs, minOut } = await client.swap({
  user: wallet.publicKey,
  mintX: NATIVE_MINT,
  mintY: USDC,
  binStep,
  amountIn: 1_000_000_000n,
  xForY: true,
  slippageBps: 50,
  quote,
});
```

---

## `RainClient` (high-level entry point)

`packages/sdk/src/client.ts`

The batteries-included surface most developers use. It wraps a `Connection`
(plus an optional program-id override and commitment) and exposes ergonomic
methods for the full market lifecycle: launch, swap, open/add/remove/close
positions, claim protocol and treasury fees, read and discover pools, read the
bin distribution, positions, and activity, and quote swaps and deposits.

Mutating methods return the built `TransactionInstruction[]` (or a
`Transaction`) plus the derived addresses; they never auto-sign. Read methods
delegate to `pool`/`position`/`fees`; math methods delegate to `math/*`.

```ts
class RainClient {
  constructor(opts: RainClientOptions);
  readonly connection: Connection;
  readonly programId: PublicKey;

  // --- addresses ---
  poolAddress(mintX: PublicKey, mintY: PublicKey, binStep: number): PublicKey;

  // --- launch (Ponk Rain) ---
  rain(params: RainParams): {
    ixs: TransactionInstruction[];
    treasuryIx: TransactionInstruction;
    pool: PublicKey;
  };

  // --- pool reads ---
  getPool(mintX: PublicKey, mintY: PublicKey, binStep: number): Promise<CloudsPool | null>;
  getPoolByAddress(pool: PublicKey): Promise<CloudsPool | null>;
  discoverPools(opts?: { resolveSymbol?: (mint: string) => string | null }): Promise<PoolInfo[]>;
  getPoolInfo(address: string): Promise<PoolInfo | null>;
  getBinDistribution(info: PoolInfo, radius?: number): Promise<BinDistribution>;
  getActivity(info: PoolInfo, limit?: number): Promise<PoolActivity[]>;

  // --- swap ---
  quoteSwap(args: {
    mintX: PublicKey; mintY: PublicKey; binStep: number;
    amountIn: bigint; xForY: boolean; maxBinArrays?: number;
  }): Promise<SwapQuote>;
  swap(args: {
    user: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number;
    amountIn: bigint; xForY: boolean; slippageBps: number; quote?: SwapQuote;
  }): Promise<{ ixs: TransactionInstruction[]; minOut: bigint }>;

  // --- liquidity previews + planning ---
  previewDeposit(bin: BinLiquidity, addX: bigint, addY: bigint): DepositPreview;
  planRange(activeBin: number, spread: number, totalX: bigint, totalY: bigint, strategy: Strategy): RangePlan;
  loadDepositContext(
    mintX: PublicKey, mintY: PublicKey, binStep: number, owner: PublicKey, binId: number,
  ): Promise<{ pool: CloudsPool; slot: BinSlot; startBin: number; binArrayExists: boolean; positionExists: boolean }>;

  // --- liquidity transactions ---
  addLiquidity(ctx: {
    owner: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number;
    lower: number; binId: number; amountX: bigint; amountY: bigint;
    binArrayExists: boolean; positionExists: boolean;
  }): TransactionInstruction[];
  removeLiquidity(args: {
    owner: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number;
    startBin: number; lower: number; binId: number; shares: bigint;
  }): TransactionInstruction;
  initBinArray(payer: PublicKey, pool: PublicKey, startBin: number): TransactionInstruction;
  initPosition(owner: PublicKey, pool: PublicKey, lower: number, upper: number): TransactionInstruction;
  closePosition(owner: PublicKey, pool: PublicKey, lower: number): TransactionInstruction;
  getPositions(info: PoolInfo, owner: PublicKey): Promise<CloudsPosition[]>;

  // --- fees (authority only) ---
  claimProtocolFees(args: { authority: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number }): TransactionInstruction;
  claimTreasuryFees(args: { authority: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number; treasury: PublicKey }): TransactionInstruction;

  // --- send ---
  sendAndConfirm(tx: Transaction, sign: (tx: Transaction) => Promise<Transaction>): Promise<string>;
}
```

`rain()` returns the create-pool instruction bundle (`ixs`: compute budget +
two vault ATA creations + `initialize_pool`) together with the best-effort
`treasuryIx` (`init_pool_treasury`) and the derived `pool` address. Send the
`ixs` first; the treasury init is a non-blocking follow-up, so a treasury
hiccup never undoes the (more important) pool creation.

**Example: launch a market, then add liquidity to the active bin.**

```ts
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { RainClient, computeActiveBinId } from "@ponkrain/sdk";

const client = new RainClient({ connection: new Connection(rpc, "confirmed") });
const SOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const binStep = 4;

// Turn a human price (USDC per SOL) into the on-chain active bin id.
const activeBinId = computeActiveBinId(170.25, binStep, 9, 6);
if (activeBinId === null) throw new Error("invalid initial price");

const { ixs, treasuryIx, pool } = client.rain({
  authority: wallet.publicKey,
  mintX: SOL,
  mintY: USDC,
  binStep,
  swapFeeBps: 4,
  protocolFeeBps: 2000, // creator keeps 20% of the swap fee
  activeBinId,
});

await client.sendAndConfirm(new Transaction().add(...ixs), wallet.signTransaction);
// best effort, separate signature:
await client.sendAndConfirm(new Transaction().add(treasuryIx), wallet.signTransaction);
```

---

## Module: `constants`

`packages/sdk/src/constants.ts`

Single source of truth for every program-level constant, address, and Anchor
discriminator, ported verbatim from the on-chain `lib.rs`/`state.rs` and the dex
`ponkclouds.ts`. No other module hardcodes these magic numbers. All
`PublicKey`s are constructed eagerly from base58 string literals; the program id
is overridable only through `RainClientOptions.programId`, never via env (this
is an env-agnostic SDK).

| Export | Type | Value / meaning |
| --- | --- | --- |
| `PONK_CLOUDS_PROGRAM_ID` | `PublicKey` | `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M` |
| `TOKEN_PROGRAM_ID` | `PublicKey` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| `ASSOCIATED_TOKEN_PROGRAM_ID` | `PublicKey` | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| `NATIVE_MINT` | `PublicKey` | wSOL `So11111111111111111111111111111111111111112` |
| `NATIVE_MINT_STR` | `string` | base58 of `NATIVE_MINT`, for string comparisons |
| `DEFAULT_TREASURY` | `PublicKey` | program `DEFAULT_TREASURY` `7nNPreWHRmKNbr8AUHFRttVw6fPFAQhVT1tfrYZ7685K` |
| `DEFAULT_TREASURY_FEE_BPS` | `number` | `100` (1% of the swap fee) |
| `BINS_PER_ARRAY` | `number` | `70` |
| `MAX_SWAP_BIN_ARRAYS` | `number` | `2` (on-chain cap: the named array plus one remaining array) |
| `MAX_BINS_PER_SWAP` | `number` | `28` (`clouds-math` walk bound) |
| `MIN_LIQUIDITY` | `bigint` | `1000n` (seeding deposit floor) |
| `MAX_SWAP_FEE_BPS` | `number` | `1000` |
| `MAX_PROTOCOL_FEE_BPS` | `number` | `5000` |
| `MAX_TREASURY_FEE_BPS` | `number` | `5000` |
| `POOL_ACCOUNT_SIZE` | `number` | `212` (dataSize filter for pool discovery) |
| `CLOUDS_SWAP_CU_LIMIT` | `number` | `200000` |
| `CLOUDS_CREATE_CU_LIMIT` | `number` | `80000` |
| `SOL_MAX_RESERVE_LAMPORTS` | `bigint` | `20_000_000n` (held back on a native-SOL "max") |
| `BPS_DENOM` | `bigint` | `10_000n` |
| `Q64` | `bigint` | `1n << 64n` (the Q64.64 unit) |
| `DISCRIMINATORS` | `Readonly<Record<...>>` | 8-byte Anchor instruction discriminators |
| `POOL_DISCRIMINATOR` | `Uint8Array` | `sha256("account:Pool")[..8]` |
| `BIN_ARRAY_DISCRIMINATOR` | `Uint8Array` | account-type detection |
| `POSITION_DISCRIMINATOR` | `Uint8Array` | account-type detection |
| `POOL_TREASURY_DISCRIMINATOR` | `Uint8Array` | account-type detection |

`DISCRIMINATORS` keys (each `Uint8Array`, `sha256("global:<name>")[..8]`):
`initializePool`, `initBinArray`, `initPosition`, `addLiquidity`,
`removeLiquidity`, `closePosition`, `swap`, `initPoolTreasury`,
`claimProtocolFees`, `claimTreasuryFees`.

> **Important: `MAX_SWAP_BIN_ARRAYS` is `2`, not `3`.** The on-chain program
> (`lib.rs`) caps a swap at the named array plus one remaining array because the
> per-bin price math (`~4.6k` CU/bin) is the binding compute bound; a 3-array
> walk would exceed the 200k CU budget and abort. The SDK uses the on-chain
> value, which differs from the older dex `ponkclouds.ts` helper that still
> reads `3`.

```ts
import { DISCRIMINATORS, MAX_SWAP_BIN_ARRAYS, Q64 } from "@ponkrain/sdk";

DISCRIMINATORS.swap;       // Uint8Array(8)
MAX_SWAP_BIN_ARRAYS;       // 2
Q64;                       // 18446744073709551616n
```

---

## Module: `version`

`packages/sdk/src/version.ts`

Dependency-free build metadata.

| Export | Type | Meaning |
| --- | --- | --- |
| `SDK_VERSION` | `string` | the SDK semver, e.g. `"0.1.0"` |
| `SDK_NAME` | `string` | `"@ponkrain/sdk"` |
| `PONK_CLOUDS_PROGRAM_ID_STR` | `string` | base58 of the default program id |
| `SDK_BUILD_INFO` | `string` | `"@ponkrain/sdk@<version> (Ponk Clouds <programId>)"` |

```ts
import { SDK_BUILD_INFO } from "@ponkrain/sdk";
console.log(SDK_BUILD_INFO);
```

---

## Module: `idl`

`packages/sdk/src/idl/ponk_clouds.ts`

The Anchor IDL as a typed TypeScript object (instructions, accounts, events,
errors), transcribed faithfully from `lib.rs`/`state.rs`. The SDK does **not**
depend on `@coral-xyz/anchor` at runtime: this is a typed data export plus the
error-code map. Consumers who prefer Anchor can build a `Program` from it.

| Export | Kind | Signature |
| --- | --- | --- |
| `PonkCloudsIdl` | type | `{ version: string; name: "ponk_clouds"; instructions; accounts; events; errors }` |
| `PONK_CLOUDS_IDL` | const | the full IDL literal |
| `CLOUDS_ERROR_CODES` | const | `Readonly<Record<number, { name: string; msg: string }>>` |
| `explainCloudsError` | function | `(code: number) => string \| null` |

Helper IDL element types are also exported (`IdlField`,
`IdlInstructionAccount`, `IdlInstruction`, `IdlAccount`, `IdlEvent`,
`IdlErrorCode`).

`CLOUDS_ERROR_CODES` maps Anchor custom error codes (`6000+`, in `CloudsError`
enum order) to `{ name, msg }`. `explainCloudsError` returns the human message
for a custom program error code, or `null` if unknown.

```ts
import { explainCloudsError, PONK_CLOUDS_IDL } from "@ponkrain/sdk";

// 6004 -> ActiveBinNotLoaded
explainCloudsError(6004); // "the active bin is not in the loaded bin array"
explainCloudsError(123);  // null

PONK_CLOUDS_IDL.name; // "ponk_clouds"
```

The error names, in code order from `6000`: `InvalidBinStep`, `InvalidFee`,
`Paused`, `WrongPool`, `ActiveBinNotLoaded`, `SwapMath`, `SlippageExceeded`,
`AmountTooLarge`, `InvalidRange`, `RangeTooWide`, `BinNotLoaded`,
`BinOutOfPosition`, `LiquidityMath`, `ZeroLiquidity`, `InsufficientShares`,
`Overflow`, `WrongMint`, `WrongVaultAuthority`, `Unauthorized`,
`PositionNotEmpty`, `BelowMinLiquidity`, `MisalignedBinArray`,
`TooManyBinArrays`, `WrongBinArrayOwner`, `BinArrayNotWritable`,
`DuplicateBinArray`, `NonContiguousBinArrays`, `WrongDirectionBinArray`,
`NonCanonicalBinArray`.

---

## Module: `pda`

`packages/sdk/src/pda.ts`

Deterministic program-derived-address and ATA derivation, byte-for-byte matching
the on-chain seeds so every address lines up with the program. Pure, no
`Connection` needed.

Seeds (matching `lib.rs`):
- pool: `[b"pool", mintX, mintY, binStep u16 LE]`
- bin array: `[b"bin_array", pool, startBin i32 LE]`
- position: `[b"position", pool, owner, lower i32 LE]`
- pool treasury: `[b"pool_treasury", pool]`
- vault: the pool PDA's ATA for the mint (the program's `vault_x` / `vault_y`)

| Export | Signature |
| --- | --- |
| `poolPda` | `(mintX: PublicKey, mintY: PublicKey, binStep: number) => PublicKey` |
| `poolPdaWithBump` | `(mintX: PublicKey, mintY: PublicKey, binStep: number) => [PublicKey, number]` |
| `binArrayPda` | `(pool: PublicKey, startBin: number) => PublicKey` |
| `positionPda` | `(pool: PublicKey, owner: PublicKey, lower: number) => PublicKey` |
| `poolTreasuryPda` | `(pool: PublicKey) => PublicKey` |
| `vaultPda` | `(pool: PublicKey, mint: PublicKey) => PublicKey` |
| `ata` | `(owner: PublicKey, mint: PublicKey) => PublicKey` |
| `arrayStartForBin` | `(binId: number) => number` |

`arrayStartForBin` returns `floor(binId / 70) * 70`, handling negatives
correctly (the start bin id of the array containing `binId`).

```ts
import { poolPda, binArrayPda, arrayStartForBin, vaultPda } from "@ponkrain/sdk";

const pool = poolPda(SOL, USDC, 4);
const startBin = arrayStartForBin(activeBinId);     // e.g. -70, 0, 70 ...
const arr = binArrayPda(pool, startBin);
const vaultX = vaultPda(pool, SOL);                 // pool's ATA for SOL
```

> Mint order is **not** canonicalized: `(X = base, Y = quote)` is the caller's
> choice and is part of the pool PDA seed. `poolPda(A, B, step)` and
> `poolPda(B, A, step)` are different pools.

---

## Module: `codec`

`packages/sdk/src/codec.ts`

Low-level little-endian byte encode/decode helpers shared by the instruction
builders and account decoders, plus human/base-unit conversions. Exported so the
rest of the SDK never re-implements byte packing; useful for advanced or
forward-compat consumers.

| Export | Signature |
| --- | --- |
| `u16le` | `(n: number) => Uint8Array` |
| `i32le` | `(n: number) => Uint8Array` |
| `u64le` | `(n: bigint) => Uint8Array` |
| `u128le` | `(n: bigint) => Uint8Array` |
| `readU128LE` | `(data: Uint8Array, o: number) => bigint` |
| `concatBytes` | `(parts: Uint8Array[]) => Buffer` |
| `toBaseUnits` | `(amount: string \| number, decimals: number) => bigint` |
| `fromBaseUnits` | `(amount: bigint, decimals: number) => string` |

`toBaseUnits` parses a human decimal amount (a string, preferred for exactness,
or a number) into base units. Parsing is exact and integer-only (no floating
point); fractional digits beyond `decimals` are truncated, and it **throws** on
malformed input. `fromBaseUnits` is the inverse, producing a trimmed human
decimal string with no trailing zeros.

```ts
import { toBaseUnits, fromBaseUnits } from "@ponkrain/sdk";

toBaseUnits("1.5", 9);          // 1500000000n
toBaseUnits("not a number", 9); // throws Error
fromBaseUnits(1500000000n, 9);  // "1.5"
```

---

## Module: `types`

`packages/sdk/src/types.ts`

The shared type backbone for the public API; no runtime code. `bigint` for all
on-chain `u64`/`u128` quantities, `number` only for bin ids, bps, and decimals.

**Decoded account shapes**

```ts
interface CloudsPool {
  address: PublicKey; authority: PublicKey;
  mintX: PublicKey; mintY: PublicKey;
  vaultX: PublicKey; vaultY: PublicKey;
  binStepBps: number; swapFeeBps: number; protocolFeeBps: number;
  activeBinId: number; paused: boolean; bump: number;
  protocolFeeX: bigint; protocolFeeY: bigint;
}

interface BinSlot { reserveX: bigint; reserveY: bigint; totalShares: bigint; }

interface DecodedBinArray { pool: PublicKey; startBinId: number; slots: BinSlot[]; bump: number; }

interface CloudsPosition {
  address: string; owner: PublicKey; pool: PublicKey;
  lowerBinId: number; upperBinId: number; shares: bigint[];
}

interface PoolTreasuryConfig {
  address: PublicKey; pool: PublicKey; treasury: PublicKey;
  treasuryFeeBps: number; bump: number;
  treasuryFeeX: bigint; treasuryFeeY: bigint;
}
```

**Pool metadata, chart, and preview shapes**

```ts
interface PoolInfo {
  address: string; name: string;
  mintX: string; symbolX: string; decimalsX: number;
  mintY: string; symbolY: string; decimalsY: number;
  binStep: number;
}

interface ChartBin {
  binId: number; price: number;
  reserveX: number; reserveY: number; // human units
  totalShares: bigint; isActive: boolean;
}

interface BinDistribution {
  activeBinId: number; binStepBps: number; swapFeeBps: number; protocolFeeBps: number;
  bins: ChartBin[];
}

interface DepositPreview { sharesMinted: bigint; usedX: bigint; usedY: bigint; }

interface SwapQuote {
  amountIn: bigint; amountInConsumed: bigint; amountInRemaining: bigint;
  amountOut: bigint; fee: bigint; protocolFee: bigint; treasuryFee: bigint;
  endBinId: number; binArraysTouched: number;
}
```

**Strategy, range plan, activity, and params**

```ts
type Strategy = "spot" | "curve" | "bidask" | "full";

interface RangePlanBin { binId: number; amountX: bigint; amountY: bigint; }
interface RangePlan { lower: number; upper: number; bins: RangePlanBin[]; }

type ActivityKind = "Add" | "Withdraw" | "Swap" | "Activity";
interface PoolActivity {
  signature: string; blockTime: number | null; err: boolean;
  kind: ActivityKind; deltaX: number; deltaY: number; signer: string | null;
}

interface RainParams {
  authority: PublicKey; mintX: PublicKey; mintY: PublicKey;
  binStep: number; swapFeeBps: number; protocolFeeBps: number; activeBinId: number;
}

interface SwapParams {
  user: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number;
  startBins: number[]; amountIn: bigint; minOut: bigint; xForY: boolean;
}

interface RainClientOptions { connection: Connection; programId?: PublicKey; commitment?: Commitment; }
```

---

## Module: `math/price`

`packages/sdk/src/math/price.ts`

Bin pricing math. Two layers: float-decimal helpers for UIs, and an exact
integer Q64.64 price ported bit-for-bit from `clouds-math/src/price.rs` so a TS
quote matches on-chain output exactly.

| Export | Signature | Notes |
| --- | --- | --- |
| `priceOfBin` | `(binId, binStepBps, decX, decY) => number` | `(1 + binStep/1e4)^binId * 10^(decX-decY)`, quote-per-base float for display |
| `binIdForPrice` | `(price, binStepBps, decX, decY) => number \| null` | inverse of `priceOfBin`; `null` if price is non-positive or non-finite |
| `binPriceQ64` | `(binId, binStepBps) => bigint \| null` | exact Q64.64 (Y per X); `null` if out of representable range; matches `clouds-math::bin_price_q64` |

`binPriceQ64` uses exponentiation-by-squaring over Q64.64 with a
floor-rounding multiply (`mul_q64`) and a `floor(2^128/d)` reciprocal for
negative bins, exactly as the on-chain code, so the off-chain quote favors the
pool identically.

```ts
import { priceOfBin, binIdForPrice, binPriceQ64, Q64 } from "@ponkrain/sdk";

priceOfBin(0, 4, 9, 6);          // ~0.001 (decimal-adjusted)
binIdForPrice(170.25, 4, 9, 6);  // e.g. 12345 (or null)
binPriceQ64(0, 4);               // === Q64 (price 1.0 at bin 0)
binPriceQ64(0, 0);               // null (zero bin step rejected)
```

---

## Module: `math/swap`

`packages/sdk/src/math/swap.ts`

Pure swap math ported bit-for-bit from `clouds-math` `swap.rs` and `router.rs`.
This powers an off-chain quote equal to the on-chain result, so the swap module
can compute an honest `minOut`.

| Export | Signature |
| --- | --- |
| `SwapMathError` | `type = "InvalidPrice" \| "InvalidFee" \| "Overflow" \| "MinLiquidity"` |
| `BinState` | `interface { priceQ64: bigint; reserveX: bigint; reserveY: bigint }` |
| `SwapFill` | `interface { amountIn: bigint; amountOut: bigint; fee: bigint; binExhausted: boolean }` |
| `MutBin` | `interface { binId: number; reserveX: bigint; reserveY: bigint }` |
| `SwapResult` | `interface { amountInConsumed; amountOut; fee; protocolFee; treasuryFee; endBinId; amountInRemaining }` |
| `swapWithinBin` | `(bin: BinState, amountIn: bigint, feeBps: number, xForY: boolean) => SwapFill` |
| `swapAcrossBins` | `(bins: MutBin[], activeIndex: number, binStepBps: number, feeBps: number, protocolFeeBps: number, treasuryFeeBps: number, amountIn: bigint, xForY: boolean) => SwapResult` |
| `mulDivFloor` | `(a: bigint, b: bigint, c: bigint) => bigint` |
| `mulDivCeil` | `(a: bigint, b: bigint, c: bigint) => bigint` |
| `protocolFeePctOfTrade` | `(protocolFeeBps: number, swapFeeBps: number) => string` |

`swapWithinBin` is the single-bin constant-sum fill (fee taken off the input,
output floored toward the pool, partial-fill gross-up via ceil). It **throws** a
`SwapMathError`-tagged `Error` on `InvalidPrice` / `InvalidFee` / `Overflow`.

`swapAcrossBins` is the cross-bin driver: it walks up/down the bin book applying
the joint protocol-plus-treasury fee clamp, capped at `MAX_BINS_PER_SWAP` (28),
and **mutates `bins` in place**, mirroring `clouds_math::swap_across_bins`
exactly. Reaching the bin cap is a graceful stop: the unfilled input is returned
as `amountInRemaining`.

`protocolFeePctOfTrade` returns the trader-facing cut as a `%` string:
`protocolFeeBps * swapFeeBps / 1e6` (the protocol fee is bps **of the swap
fee**, not of the trade, so a raw `protocolFeeBps/100` badly overstates it).

```ts
import { swapAcrossBins, protocolFeePctOfTrade } from "@ponkrain/sdk";

const bins = [
  { binId: -1, reserveX: 0n, reserveY: 1_000_000n },
  { binId: 0, reserveX: 1_000_000n, reserveY: 1_000_000n },
  { binId: 1, reserveX: 1_000_000n, reserveY: 0n },
];
const res = swapAcrossBins(bins, 1, 4, 4, 2000, 100, 500_000n, true);
res.amountOut;        // bigint
res.amountInRemaining // 0n on a complete fill

protocolFeePctOfTrade(2000, 4); // "0.0008%"
```

---

## Module: `math/liquidity`

`packages/sdk/src/math/liquidity.ts`

Pure single-bin share accounting ported bit-for-bit from
`clouds-math/src/liquidity.rs`, plus the range planner.

| Export | Signature |
| --- | --- |
| `BinLiquidity` | `interface { totalShares: bigint; reserveX: bigint; reserveY: bigint }` |
| `previewDeposit` | `(bin: BinLiquidity, addX: bigint, addY: bigint) => DepositPreview` |
| `previewWithdraw` | `(bin: BinLiquidity, shares: bigint) => { outX: bigint; outY: bigint }` |
| `planRange` | `(activeBin: number, spread: number, totalX: bigint, totalY: bigint, strategy: Strategy) => RangePlan` |

`previewDeposit` mirrors `clouds_math::deposit`: the seed path enforces the
`MIN_LIQUIDITY` floor (and returns `sharesMinted: 0n` where the program would
revert, e.g. a dust seed or a zero deposit), and subsequent deposits mint the
pro-rata min-of-sides shares with surplus-refund (`usedX`/`usedY` via
ceil-then-cap). `previewWithdraw` mirrors `clouds_math::withdraw` (floor-toward-
pool proportional reserves).

`planRange` distributes a deposit around the active bin per the strategy: base
(X) fills bins strictly **above** the active price, quote (Y) strictly **below**,
and the active bin is skipped unless `spread === 0` (because the active bin holds
both reserves and an off-ratio pair would be partially refunded). Strategies:
`spot`/`full` uniform, `curve` peaks nearest the price, `bidask` peaks at the
edges.

```ts
import { previewDeposit, planRange } from "@ponkrain/sdk";

const bin = { totalShares: 2_000n, reserveX: 1_000n, reserveY: 1_000n };
previewDeposit(bin, 100n, 50n);
// { sharesMinted: 100n, usedX: 50n, usedY: 50n } -> surplus X refunded

const plan = planRange(0, 3, 9_000n, 6_000n, "curve");
// plan.lower = -3, plan.upper = 3, X above active, Y below
```

---

## Module: `pool`

`packages/sdk/src/pool.ts`

Read and decode pool state from chain. Decoders use the exact byte offsets of the
`Pool`, `BinArray`, individual bin slots, and `PoolTreasury` accounts, plus
full discovery via `getProgramAccounts` (`dataSize 212` + `dataSlice`) with
batch mint-decimal reads. No symbol-registry dependency: symbols default to a
short-mint fallback unless a caller supplies a `resolveSymbol` resolver. No data
is fabricated; empty bins read as zero, and RPC failures degrade to `[]`/`null`.

| Export | Signature |
| --- | --- |
| `decodePool` | `(address: PublicKey, data: Uint8Array) => CloudsPool` |
| `decodeBinArray` | `(data: Uint8Array) => DecodedBinArray` |
| `decodeBinSlot` | `(data: Uint8Array, startBin: number, binId: number) => BinSlot` |
| `decodePoolTreasury` | `(address: PublicKey, data: Uint8Array) => PoolTreasuryConfig` |
| `fetchPool` | `(conn, mintX, mintY, binStep) => Promise<CloudsPool \| null>` |
| `fetchPoolByAddress` | `(conn, pool) => Promise<CloudsPool \| null>` |
| `fetchPoolTreasury` | `(conn, pool) => Promise<PoolTreasuryConfig \| null>` |
| `readPoolInfoOnChain` | `(conn, address, opts?) => Promise<PoolInfo \| null>` |
| `discoverPools` | `(conn, opts?) => Promise<PoolInfo[]>` |
| `readBinDistribution` | `(conn, info, radius?) => Promise<BinDistribution>` |
| `readPoolActivity` | `(conn, info, limit?) => Promise<PoolActivity[]>` |

`readPoolInfoOnChain` and `discoverPools` accept
`opts?: { resolveSymbol?: (mint: string) => string | null }`.
`readBinDistribution` reads every bin in `[active-radius, active+radius]` in
human units (zeros for empty bins). `readPoolActivity` classifies recent txs by
net vault deltas (both up = Add, both down = Withdraw, opposite = Swap).

`Pool` byte offsets (for reference): `authority@8`, `mintX@40`, `mintY@72`,
`vaultX@104`, `vaultY@136`, `binStep u16 @168`, `swapFee@170`,
`protocolFee@172`, `activeBin i32 @174`, `paused@178`, `bump@179`,
`protocolFeeX u128 @180`, `protocolFeeY@196`. `PoolTreasury`: `pool@8`,
`treasury@40`, `feeBps@72`, `bump@74`, `treasuryFeeX u128 @75`,
`treasuryFeeY@91`.

```ts
import { fetchPool, discoverPools, readBinDistribution } from "@ponkrain/sdk";

const pool = await fetchPool(conn, SOL, USDC, 4);
const pools = await discoverPools(conn, {
  resolveSymbol: (mint) => myRegistry[mint]?.symbol ?? null,
});
const dist = await readBinDistribution(conn, pools[0], 30);
```

---

## Module: `rain`

`packages/sdk/src/rain/createPool.ts` (barrelled at `./rain`)

Ponk Rain: build the transactions that launch a new Ponk Clouds market. Account
order is frozen to the program's `InitializePool` / `InitPoolTreasury` structs.
The bin step is part of the pool PDA seed; mint order (`X = base`, `Y = quote`)
is **not** canonicalized. Fee caps are validated locally before building
(`swapFee <= 1000`, `protocolFee <= 5000`, `binStep > 0`) so a bad config fails
on your machine, not on-chain.

| Export | Signature |
| --- | --- |
| `validateRainParams` | `(params: RainParams) => void` (throws with a clear message on out-of-range binStep/swapFee/protocolFee) |
| `computeActiveBinId` | `(price: number, binStep: number, decX: number, decY: number) => number \| null` (convenience re-export of `binIdForPrice`) |
| `initializePoolIx` | `(params: RainParams) => TransactionInstruction` |
| `createPoolComputeBudgetIx` | `() => TransactionInstruction` (`setComputeUnitLimit(80_000)`) |
| `createPoolIxs` | `(params: RainParams) => TransactionInstruction[]` |
| `initPoolTreasuryIx` | `(params: { authority: PublicKey; pool: PublicKey }) => TransactionInstruction` |
| `initRainBinArrayIx` | `(payer: PublicKey, pool: PublicKey, startBin: number) => TransactionInstruction` |
| `seedActiveBinArrayIx` | `(params: { authority, mintX, mintY, binStep, activeBinId }) => TransactionInstruction` |
| `createMarket` | `(params: CreateMarketParams) => CreateMarketPlan` |
| `CreateMarketParams` | interface (price-first launch inputs) |
| `CreateMarketPlan` | interface (the assembled launch plan + derived addresses) |

`createPoolIxs` returns the full ordered bundle:
`[setComputeUnitLimit(80k), createAtaIdempotent(vaultX), createAtaIdempotent(vaultY), initialize_pool]`.
The vaults are the pool PDA's ATAs (owner == pool), satisfying the program's
`vault.owner == pool` constraint, and must exist before `initialize_pool` runs;
`createPoolIxs` prepends exactly those creations. `initRainBinArrayIx` and
`seedActiveBinArrayIx` are convenience builders for preparing the active bin's
array at launch (so the first deposit does not have to). `createMarket` is the
price-first planner: it resolves the active bin from a human initial price and
assembles a `CreateMarketPlan` with the create ixs, the treasury ix, and the
derived pool address.

```ts
import { createPoolIxs, initPoolTreasuryIx, validateRainParams, poolPda } from "@ponkrain/sdk";

const params = {
  authority: wallet.publicKey,
  mintX: SOL, mintY: USDC, binStep: 4,
  swapFeeBps: 4, protocolFeeBps: 2000, activeBinId,
};
validateRainParams(params);           // throws if out of range

const ixs = createPoolIxs(params);     // compute budget + 2 vault ATAs + initialize_pool
const pool = poolPda(SOL, USDC, 4);
const treasuryIx = initPoolTreasuryIx({ authority: wallet.publicKey, pool });
```

---

## Module: `swap`

`packages/sdk/src/swap.ts`

Build a Ponk Clouds swap transaction and quote it off-chain. The swap account
order is frozen to the program's `Swap` struct:
`[user, pool, primaryBinArray, vaultX, vaultY, userX, userY, tokenProgram]`,
then up to `MAX_SWAP_BIN_ARRAYS - 1` writable remaining `BinArray`s.
Instruction data is `disc + amountIn u64 LE + minOut u64 LE + xForY u8`.

| Export | Signature |
| --- | --- |
| `swapStartBins` | `(activeBinId: number, count: number, xForY: boolean) => number[]` |
| `buildSwapIx` | `(params: SwapParams) => TransactionInstruction` |
| `buildSwapIxs` | `(params: SwapParams) => TransactionInstruction[]` (`[setComputeUnitLimit(200k), swap]`) |
| `swapComputeBudgetIx` | `() => TransactionInstruction` |
| `quoteSwap` | `(conn, args) => Promise<SwapQuote>` |
| `minOutForSlippage` | `(quotedOut: bigint, slippageBps: number) => bigint` |

`swapStartBins` produces the contiguous array start ids in travel order
(`startBins[0]` is the active bin's array; `xForY` walks down into lower bins,
`!xForY` walks up). `buildSwapIx` enforces the `1..MAX_SWAP_BIN_ARRAYS`
array-count bound, throwing locally on violation. `quoteSwap` loads the pool plus
the touched bin arrays and runs `math/swap.swapAcrossBins` to produce an exact
`SwapQuote`:

```ts
quoteSwap(conn, {
  mintX: PublicKey; mintY: PublicKey; binStep: number;
  amountIn: bigint; xForY: boolean; maxBinArrays?: number;
}): Promise<SwapQuote>
```

`minOutForSlippage` is `floor(quotedOut * (10000 - slippageBps) / 10000)`.

```ts
import { quoteSwap, buildSwapIxs, swapStartBins, minOutForSlippage } from "@ponkrain/sdk";

const quote = await quoteSwap(conn, { mintX: SOL, mintY: USDC, binStep: 4, amountIn: 1_000_000_000n, xForY: true });
const minOut = minOutForSlippage(quote.amountOut, 50); // 0.5% slippage

const ixs = buildSwapIxs({
  user: wallet.publicKey,
  mintX: SOL, mintY: USDC, binStep: 4,
  startBins: swapStartBins(quote.endBinId, quote.binArraysTouched, true),
  amountIn: quote.amountInConsumed,
  minOut,
  xForY: true,
});
```

---

## Module: `position`

`packages/sdk/src/position.ts`

Open, fund, and close LP positions, with the wSOL wrap/unwrap helpers and an
owner-position discovery. Account orders are frozen to the program's
`InitializeBinArray` / `InitializePosition` / `ModifyLiquidity` /
`ClosePosition` structs.

| Export | Signature |
| --- | --- |
| `createAtaIdempotentIx` | `(payer, owner, mint) => TransactionInstruction` |
| `wrapSolIxs` | `(owner: PublicKey, lamports: bigint) => TransactionInstruction[]` |
| `closeWsolIx` | `(owner: PublicKey) => TransactionInstruction` |
| `maxSpendableBaseUnits` | `(amountBaseUnits: bigint, mint: PublicKey) => bigint` |
| `initBinArrayIx` | `(payer, pool, startBin) => TransactionInstruction` |
| `initPositionIx` | `(owner, pool, lower, upper) => TransactionInstruction` |
| `addLiquidityIx` | `(args: { owner, mintX, mintY, binStep, startBin, lower, binId, amountX, amountY }) => TransactionInstruction` |
| `removeLiquidityIx` | `(args: { owner, mintX, mintY, binStep, startBin, lower, binId, shares }) => TransactionInstruction` |
| `closePositionIx` | `(owner, pool, lower) => TransactionInstruction` |
| `decodePosition` | `(address: PublicKey, data: Uint8Array) => CloudsPosition` |
| `readPositions` | `(conn, info, owner) => Promise<CloudsPosition[]>` |
| `loadDepositContext` | `(conn, mintX, mintY, binStep, owner, binId) => Promise<{ pool; slot; startBin; binArrayExists; positionExists }>` |
| `openPositionIxs` | `(ctx) => TransactionInstruction[]` |

`maxSpendableBaseUnits` returns the full balance, minus
`SOL_MAX_RESERVE_LAMPORTS` when the mint is wSOL (so a "max" deposit/swap leaves
SOL for the wrap fee + rent). `wrapSolIxs` creates the wSOL ATA (idempotent),
transfers lamports, and `SyncNative`s; `closeWsolIx` returns leftover wrapped
SOL + rent to the owner.

`loadDepositContext` reports whether the target bin array and position already
exist so callers can prepend the init ixs. `openPositionIxs` assembles a full
single-bin add bundle, conditionally prepending the inits:

```ts
openPositionIxs(ctx: {
  owner: PublicKey; mintX: PublicKey; mintY: PublicKey; binStep: number;
  lower: number; binId: number; amountX: bigint; amountY: bigint;
  binArrayExists: boolean; positionExists: boolean;
}): TransactionInstruction[]   // [initBinArray?, initPosition?, addLiquidity]
```

`readPositions` discovers an owner's positions in a pool via
`getProgramAccounts` (`memcmp` owner@8, pool@40), returning only positions with
non-zero shares.

```ts
import { loadDepositContext, openPositionIxs } from "@ponkrain/sdk";

const ctx = await loadDepositContext(conn, SOL, USDC, 4, wallet.publicKey, activeBinId + 1);
const ixs = openPositionIxs({
  owner: wallet.publicKey,
  mintX: SOL, mintY: USDC, binStep: 4,
  lower: activeBinId + 1, binId: activeBinId + 1,
  amountX: 1_000_000_000n, amountY: 0n, // bin above active is pure-X
  binArrayExists: ctx.binArrayExists,
  positionExists: ctx.positionExists,
});
```

---

## Module: `fees`

`packages/sdk/src/fees.ts`

Authority-only fee-claim builders and accrued-fee reads. Account orders match the
program's `ClaimProtocolFees` (`authority, pool, vaultX, vaultY,
authorityTokenX, authorityTokenY, tokenProgram`) and `ClaimTreasuryFees`
(`authority, pool, poolTreasury, vaultX, vaultY, treasuryTokenX, treasuryTokenY,
tokenProgram`) structs. The treasury destination ATAs are owned by the
configured treasury wallet (the program enforces this).

| Export | Signature |
| --- | --- |
| `claimProtocolFeesIx` | `(args: { authority, mintX, mintY, binStep }) => TransactionInstruction` |
| `claimTreasuryFeesIx` | `(args: { authority, mintX, mintY, binStep, treasury }) => TransactionInstruction` |
| `readAccruedProtocolFees` | `(conn, mintX, mintY, binStep) => Promise<{ feeX: bigint; feeY: bigint } \| null>` |
| `readAccruedTreasuryFees` | `(conn, pool) => Promise<{ feeX: bigint; feeY: bigint } \| null>` |

Accrued amounts come straight off the decoded `Pool` (`protocolFeeX`/`Y`) and
`PoolTreasury` (`treasuryFeeX`/`Y`); the claim transactions zero the
accumulators on-chain and transfer the balances out, signed by the pool PDA.

```ts
import { readAccruedProtocolFees, claimProtocolFeesIx } from "@ponkrain/sdk";

const accrued = await readAccruedProtocolFees(conn, SOL, USDC, 4);
if (accrued && (accrued.feeX > 0n || accrued.feeY > 0n)) {
  const ix = claimProtocolFeesIx({ authority: wallet.publicKey, mintX: SOL, mintY: USDC, binStep: 4 });
}
```

---

## Module: `confirm`

`packages/sdk/src/confirm.ts`

Send/confirm helpers that avoid the standard confirmation footguns. Nothing
here holds a key, reads program state, or depends on the rest of the SDK; it
operates purely on `@solana/web3.js` primitives.

| Export | Signature |
| --- | --- |
| `PACKET_DATA_SIZE` | `number` (`1232`, the Solana wire packet cap in bytes) |
| `SendAndConfirmOptions` | `interface { commitment?: Commitment; timeoutMs?: number; pollIntervalMs?: number; skipPreflight?: boolean }` |
| `sendAndConfirm` | `(connection: Connection, tx: Transaction, sign: (tx: Transaction) => Promise<Transaction>, opts?: SendAndConfirmOptions) => Promise<string>` |
| `confirmSignature` | `(connection: Connection, signature: string, opts?: { commitment?: Commitment; timeoutMs?: number; pollIntervalMs?: number }) => Promise<void>` |
| `transactionSize` | `(ixs: TransactionInstruction[], feePayer: PublicKey, signerCount?: number) => number` |
| `packInstructions` | `(ixs: TransactionInstruction[], feePayer: PublicKey, signerCount?: number) => TransactionInstruction[][]` |

`sendAndConfirm` is the convenience used by `RainClient.sendAndConfirm`: it sets
a fresh blockhash (and `lastValidBlockHeight`) when unset, hands the prepared
transaction to the caller's `sign` callback (key custody stays with the caller),
defaults the `feePayer` to the first signer if still unset, sends the raw signed
bytes, and confirms via `confirmSignature`.

`confirmSignature` confirms by **polling `getSignatureStatuses`** rather than
trusting the WebSocket `signatureSubscribe` notification (public/Helius RPC
nodes routinely drop it, which makes the blockhash strategy falsely report
"block height exceeded" while the tx has actually landed). It throws on an
on-chain error (surfacing the reported error), and throws once the configured
`timeoutMs` elapses without reaching the target commitment. Exposed separately
for callers that broadcast the transaction themselves and only need the
status-polling confirmation.

`transactionSize` returns the true serialized wire size, in bytes, of a legacy
transaction carrying `ixs` (fee payer plus `signerCount` signatures), and
`packInstructions` greedily packs an ordered instruction list into the fewest
legacy transactions that each serialize under `PACKET_DATA_SIZE`, preserving
order. An instruction that cannot fit even on its own throws.

```ts
import { sendAndConfirm, packInstructions } from "@ponkrain/sdk";

const groups = packInstructions(allIxs, wallet.publicKey);
for (const ixs of groups) {
  const tx = new Transaction().add(...ixs);
  await sendAndConfirm(conn, tx, wallet.signTransaction);
}
```

---

## Conventions and guarantees

- **No auto-signing.** Every builder returns instructions or an unsigned
  `Transaction`; the caller signs. Key custody stays with the consumer.
- **Honest nulls.** Read functions return `null`/`[]` (not fabricated data) when
  an account is missing or an RPC call fails, and price/bin conversions
  (`binIdForPrice`, `binPriceQ64`) return `null` on out-of-range input. UIs
  should render `--`, never a guessed value. (Amount parsing differs:
  `toBaseUnits` **throws** on malformed input rather than returning a value, so
  callers validate before calling.)
- **`bigint` for chain quantities.** All `u64`/`u128` amounts (reserves, shares,
  fees, amounts) are `bigint`. `number` is used only for bin ids, basis points,
  and token decimals.
- **Exact off-chain math.** `math/price`, `math/swap`, and `math/liquidity` are
  ported bit-for-bit from the `clouds-math` Rust crate, so an off-chain quote or
  deposit preview equals the on-chain result and rounding favors the pool
  identically.
- **Fees are bps of the swap fee.** `protocolFeeBps` and `treasuryFeeBps` are a
  cut **of the swap fee**, not of the trade. Use `protocolFeePctOfTrade` to show
  the real trader-facing percentage.
- **Mint order is meaningful.** `(X = base, Y = quote)` is not canonicalized and
  is part of the pool identity and PDA seed.
- **Program id override.** Pass `programId` in `RainClientOptions` to target a
  local/devnet redeploy; otherwise the default deployed id is used. The SDK never
  reads env.
- **Zero protocol fee at the AMM level.** Ponk Clouds itself takes no protocol
  fee; any protocol cut a pool charges accrues to the pool creator (the
  authority), and a flat 1% treasury cut funds the platform, both configurable
  per pool and bounded by the on-chain caps.
- **Test on devnet first.** Point the SDK at a local validator or devnet while you build.
```
