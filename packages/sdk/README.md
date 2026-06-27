# @ponkrain/sdk

TypeScript SDK for **Ponk Rain**: launch and operate [Ponk Clouds](https://ponk.exchange) bin-based DLMM markets on Solana.

Ponk Clouds is PONK's own concentrated-liquidity DLMM AMM, with **zero protocol fee at the AMM level**. The entire swap fee is set per pool by the pool creator and shared between liquidity providers and the creator's own protocol cut, plus a small flat platform treasury cut. This SDK gives you everything needed to drive that program from a wallet: program-derived-address derivation, account decoders, exact off-chain swap and liquidity math that matches the on-chain result byte-for-byte, and raw `@solana/web3.js` transaction builders.

The SDK wraps the deployed program at `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`.

- **Non-custodial.** Every mutating call returns an unsigned `TransactionInstruction[]` (or a `Transaction`). The SDK never holds, derives, or asks for a private key. You sign with your own wallet or keypair.
- **Zero heavy dependencies.** Only `@solana/web3.js`. No Anchor at runtime, all transactions are built from raw instructions, so the bundle stays small and portable across browser and Node.
- **Honest reads.** On-chain reads return real values or `null`/`0`. Empty bins read as zero reserves, not guesses. Nothing is fabricated.

## Install

```bash
pnpm add @ponkrain/sdk @solana/web3.js
# or
npm install @ponkrain/sdk @solana/web3.js
```

`@solana/web3.js` is a peer-level dependency you supply. Node >= 20. The package ships ESM and CJS builds plus type declarations.

## Quick start

Everything below uses the high-level `RainClient`, the batteries-included entry point. It wraps a `Connection` and exposes the full market lifecycle. Each mutating method returns the built instructions and the derived addresses, never auto-signing.

```ts
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { RainClient } from "@ponkrain/sdk";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const client = new RainClient({ connection });

// Your wallet. In a browser, use a wallet adapter's signTransaction instead.
const wallet = Keypair.fromSecretKey(/* ... */);
const sign = async (tx: Transaction) => {
  tx.partialSign(wallet);
  return tx;
};
```

### 1. Create a market (Ponk Rain)

A market is identified by `(mintX, mintY, binStep)`. `mintX` is the base, `mintY` is the quote. The order is **not** canonicalized, it is your choice and it is part of the pool address. The signer becomes the pool authority: only it can later change fees, pause the pool, or claim protocol fees.

```ts
import { RainClient, computeActiveBinId } from "@ponkrain/sdk";

const SOL = new PublicKey("So11111111111111111111111111111111111111112"); // base, 9 dp
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // quote, 6 dp

// Turn a human price (quote per base) into the active bin id the program stores.
const activeBinId = computeActiveBinId(150, /* binStep */ 4, /* decX */ 9, /* decY */ 6);
if (activeBinId === null) throw new Error("invalid initial price");

const { ixs, treasuryIx, pool } = client.rain({
  authority: wallet.publicKey,
  mintX: SOL,
  mintY: USDC,
  binStep: 4, // bin step in bps, part of the pool address
  swapFeeBps: 4, // total fee a trader pays the pool, <= 1000
  protocolFeeBps: 2000, // your cut OF the swap fee (bps), <= 5000
  activeBinId,
});

// `ixs` already carries the compute-budget limit, the two pool-vault ATA
// creations, and initialize_pool. `treasuryIx` initializes the per-pool
// treasury so the platform cut has a home from the first swap. Land them
// together.
const tx = new Transaction().add(...ixs, treasuryIx);
const sig = await client.sendAndConfirm(tx, sign);
console.log("market created:", pool.toBase58(), sig);
```

Fee caps are validated locally before any instruction is built, so a bad config fails on your machine, not on-chain (`binStep > 0`, `swapFeeBps <= 1000`, `protocolFeeBps <= 5000`).

### 2. Swap

`quoteSwap` reads the pool and bin arrays and runs the exact off-chain math, so the quoted `amountOut` equals the on-chain result. `swap` turns a quote (or a fresh read) plus a slippage tolerance into an honest `minOut` and the signed-ready instructions.

```ts
// Quote 1 SOL -> USDC (xForY: spending base X for quote Y).
const quote = await client.quoteSwap({
  mintX: SOL,
  mintY: USDC,
  binStep: 4,
  amountIn: 1_000_000_000n, // 1 SOL in base units
  xForY: true,
});
console.log("out:", quote.amountOut, "fee:", quote.fee, "endBin:", quote.endBinId);

// Build the swap with 50 bps of slippage. Reuses the quote above.
const { ixs, minOut } = await client.swap({
  user: wallet.publicKey,
  mintX: SOL,
  mintY: USDC,
  binStep: 4,
  amountIn: 1_000_000_000n,
  xForY: true,
  slippageBps: 50,
  quote,
});

const tx = new Transaction().add(...ixs);
const sig = await client.sendAndConfirm(tx, sign);
console.log("swapped, minOut floor was", minOut, sig);
```

A swap may touch up to `MAX_SWAP_BIN_ARRAYS` (2) contiguous bin arrays. The instruction builder enforces that bound locally.

### 3. Read a pool

```ts
import { fromBaseUnits } from "@ponkrain/sdk";

// By (mintX, mintY, binStep)...
const cloudsPool = await client.getPool(SOL, USDC, 4);
if (cloudsPool) {
  console.log("active bin:", cloudsPool.activeBinId);
  console.log("swap fee bps:", cloudsPool.swapFeeBps);
  console.log("accrued protocol fee X:", cloudsPool.protocolFeeX);
}

// ...or resolve display info (symbols, decimals) by pool address.
const info = await client.getPoolInfo("2wdVxUfi4MuyxKvixmtfk6dHFTBM4DJA3YRXHLpEfFj5");
if (info) {
  // Liquidity distribution around the active price, in human units.
  const dist = await client.getBinDistribution(info, /* radius */ 30);
  const active = dist.bins.find((b) => b.isActive);
  console.log(info.name, "price at active bin:", active?.price);

  // Recent on-chain activity, classified by net vault movement.
  const activity = await client.getActivity(info, 15);
  console.log(activity.length, "recent events");
}

// Discover every Ponk Clouds pool on chain.
const pools = await client.discoverPools();
console.log("live markets:", pools.map((p) => p.name));
```

All on-chain quantities (`u64` / `u128`) are `bigint`. Use `fromBaseUnits(amount, decimals)` / `toBaseUnits(input, decimals)` to convert to and from human decimal strings.

## API overview

The single import surface is `@ponkrain/sdk`. `RainClient` is exported both as a named export and as the default.

### `RainClient`

The high-level wrapper most app developers will use. Construct it with `{ connection, programId?, commitment? }`.

| Area | Methods |
| --- | --- |
| Addresses | `poolAddress(mintX, mintY, binStep)` |
| Launch | `rain(params)` |
| Swap | `quoteSwap(args)`, `swap(args)` |
| Read pools | `getPool`, `getPoolByAddress`, `getPoolInfo`, `discoverPools`, `getBinDistribution`, `getActivity` |
| Liquidity | `previewDeposit`, `planRange`, `loadDepositContext`, `addLiquidity`, `removeLiquidity`, `closePosition`, `getPositions` |
| Fees (authority only) | `claimProtocolFees`, `claimTreasuryFees` |
| Send | `sendAndConfirm(tx, sign)` |

### Low-level modules

If you want finer control than `RainClient`, every building block is exported directly:

- **`constants`** Program id, token-program ids, `NATIVE_MINT`, fee caps, bin geometry (`BINS_PER_ARRAY`, `MAX_SWAP_BIN_ARRAYS`, `MAX_BINS_PER_SWAP`), CU limits, account sizes, Anchor discriminators. The single source of truth for every magic number.
- **`idl`** The `PONK_CLOUDS_IDL` data object plus `CLOUDS_ERROR_CODES` and `explainCloudsError(code)` for mapping a custom program error code to a human message.
- **`pda`** Deterministic address derivation, matching the program seeds byte-for-byte: `poolPda`, `binArrayPda`, `positionPda`, `poolTreasuryPda`, `vaultPda`, `ata`, and the `arrayStartForBin` grid helper.
- **`codec`** Little-endian byte helpers (`u16le`, `i32le`, `u64le`, `u128le`, `readU128LE`, `concatBytes`) and the human-decimal converters (`toBaseUnits`, `fromBaseUnits`).
- **`math/price`** Bin pricing: `priceOfBin` / `binIdForPrice` (float, for display) and `binPriceQ64` (exact Q64.64, matches the on-chain price).
- **`math/swap`** Pure swap math ported bit-for-bit from the program: `swapWithinBin`, `swapAcrossBins`, `mulDivFloor`, `mulDivCeil`, `protocolFeePctOfTrade`. Powers off-chain quotes that equal the on-chain result.
- **`math/liquidity`** Single-bin share accounting: `previewDeposit`, `previewWithdraw`, and the `planRange` range planner for `spot` / `curve` / `bidask` / `full` strategies.
- **`pool`** Account decoders (`decodePool`, `decodeBinArray`, `decodeBinSlot`, `decodePoolTreasury`) and chain reads (`fetchPool`, `fetchPoolByAddress`, `fetchPoolTreasury`, `readPoolInfoOnChain`, `discoverPools`, `readBinDistribution`, `readPoolActivity`).
- **`rain`** Market-launch instruction builders: `initializePoolIx`, `createPoolIxs`, `initPoolTreasuryIx`, `computeActiveBinId`, `validateRainParams`.
- **`swap`** Swap instruction builders and quoting: `swapStartBins`, `buildSwapIx`, `buildSwapIxs`, `swapComputeBudgetIx`, `quoteSwap`, `minOutForSlippage`.
- **`position`** LP lifecycle: `initBinArrayIx`, `initPositionIx`, `addLiquidityIx`, `removeLiquidityIx`, `closePositionIx`, `decodePosition`, `readPositions`, `loadDepositContext`, `openPositionIxs`, plus wSOL helpers (`createAtaIdempotentIx`, `wrapSolIxs`, `closeWsolIx`, `maxSpendableBaseUnits`).
- **`fees`** Authority-only fee claims and reads: `claimProtocolFeesIx`, `claimTreasuryFeesIx`, `readAccruedProtocolFees`, `readAccruedTreasuryFees`.
- **`confirm`** Robust send/confirm helpers: `sendAndConfirm`, `confirmSignature` (polls signature status instead of trusting a dropped WebSocket notification), `packInstructions` (packs an ordered instruction list into the fewest legacy transactions under the `PACKET_DATA_SIZE` (1232-byte) limit, preserving order), and `transactionSize`.

### Working with native SOL

Ponk Clouds is an SPL-token AMM, so native SOL must be wrapped into wSOL. Use `wrapSolIxs(owner, lamports)` before a deposit or swap and `closeWsolIx(owner)` after, packed into the same transaction so they land atomically. `maxSpendableBaseUnits(amount, mint)` reserves `SOL_MAX_RESERVE_LAMPORTS` (0.02 SOL) for rent and fees when the input is wSOL, so a "max" amount does not strand the wrap.

## Non-custodial by design

This SDK never takes custody of funds. There is no key storage, no signer baked into the client, and no auto-send on a mutating call. Every transaction-producing method hands back unsigned `TransactionInstruction[]` or a `Transaction` and the addresses it derived. You decide how to sign:

- In a browser, pass your wallet adapter's `signTransaction` to `sendAndConfirm`.
- In Node or a CLI, sign with a `Keypair` you control.

Read methods only call your `Connection`, they never request a signature. The pool authority is whichever wallet signs `rain`; protocol-fee and treasury-fee claims must be signed by that same authority, the program enforces it on-chain.

## Determinism and correctness

The math modules (`math/swap`, `math/liquidity`, `math/price`) are ported bit-for-bit from the program's `clouds-math` crate, all over `bigint` with no floats on the exact path. A `quoteSwap` or `previewDeposit` returns exactly what the program will compute, so the `minOut` you sign is honest and a deposit preview equals what gets minted and pulled. The PDA seeds and account byte offsets match the deployed program exactly.

## License

Apache-2.0
