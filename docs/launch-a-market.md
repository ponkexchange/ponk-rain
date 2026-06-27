# Launch a market

End to end: launch your first **Ponk Clouds** market (a "Rain"), then seed it
with liquidity and place a swap against it. This tutorial covers both paths:

1. **With the scaffold** (`@ponkrain/launch`) - point and click in the UI.
2. **With the SDK directly** (`@ponkrain/sdk`) - a small Node script that builds,
   signs, and sends the same transactions.

Both paths drive the **same deployed program**
(`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`) and build byte-for-byte the same
instructions, so pick whichever fits how you work.

> **UNAUDITED.** The Ponk Clouds program holds user funds and has not passed an
> external security audit. Run this against a **local validator or devnet** until
> that changes. Do not deposit funds you are not prepared to lose.

If you have not cloned, installed, and configured the repo yet, do the
[quickstart](./quickstart.md) first, then come back here.

## What "launching a market" means

A Ponk Clouds market is a **pool**: a `(mintX, mintY, binStep)` triple. Creating
one is three on-chain things, in order:

1. **`initialize_pool`** - records the authority (you), the two mints, the two
   vaults, the bin step, the swap fee, your creator protocol fee, and the
   starting active bin. The pool address is a PDA derived from
   `(mintX, mintY, binStep)`, so there is exactly one pool per pair per bin step.
   The two vaults are the pool PDA's associated token accounts and must be
   created first; the kit prepends their idempotent creation for you.
2. **`init_pool_treasury`** (best effort) - creates the per-pool treasury PDA so
   the flat 1% platform cut OF the swap fee has a home from the first swap. This
   is a separate transaction so a treasury hiccup can never undo the pool
   creation. The pool is fully usable without it (the treasury cut is simply 0
   until it exists).
3. **Seed liquidity** - the pool exists but is empty until someone deposits.
   Until at least the active bin is funded, swaps have nothing to fill. The
   creator usually adds the first liquidity right after launch.

A few rules that the whole kit enforces, ported verbatim from the program:

- **Mint order is yours and is not reordered.** `mintX` = base, `mintY` = quote.
  Price is quoted as quote-per-base. The order is part of the pool's identity
  (its PDA seed), so be deliberate about which side is which.
- **Fee caps.** Swap fee `<= 1000` bps (10%); creator protocol fee `<= 5000` bps
  OF the swap fee (LPs always keep at least half); bin step `> 0`. The SDK
  validates these locally and throws before building, so a bad config fails on
  your machine, not on-chain.
- **Classic SPL tokens only.** Token-2022 mints are not supported by the program
  and are rejected up front.
- **Zero protocol fee at the AMM level.** The program takes no cut of the trade.
  The swap fee you set is split three ways: your creator protocol cut, the flat
  1% platform treasury cut, and the rest to LPs.

### Picking parameters

| Parameter | What it controls | Reasonable starting point |
| --- | --- | --- |
| **Bin step** (bps) | How far apart adjacent price bins sit. Smaller steps concentrate liquidity tighter (lower slippage, narrower range per bin); larger steps span more price per bin. Part of the PDA seed. | `4` for a liquid major pair like SOL/USDC; `20`-`100` for a new/volatile token. |
| **Swap (base) fee** (bps) | What a trader pays the pool per swap, shared between LPs and the protocol cuts. | `4`-`30` bps. |
| **Creator protocol fee** (bps OF the swap fee) | Your cut, earned on every swap for the life of the pool. `0` means LPs keep the whole fee minus the 1% treasury cut. Capped at 5000 (50%). | `2000` (20%) earns by default without starving LPs. |
| **Initial price** (quote per base) | Sets the starting active bin. Prices live on the discrete `(1 + binStep/10000)^binId` grid, so the resolved bin's exact price differs slightly from what you type. | The pair's real market price. |

Because the active bin is a discrete grid point, always read back the
**resolved** bin price (the kit shows it) so you confirm the real opening price
rather than assuming an exact match.

---

## Path A: launch with the scaffold

This is the fastest path: the launchpad UI builds, validates, signs, and confirms
everything for you.

### 1. Run the app

From the repo root (see the [quickstart](./quickstart.md) for first-time setup):

```bash
pnpm --filter @ponkrain/launch run dev
```

Open `http://localhost:3100`. Make sure `NEXT_PUBLIC_PONK_CLOUDS_RPC` in
`scaffold/launch/.env.local` points at an RPC where the program is deployed (a
local validator until the audit). Connect a Phantom, Solflare, or Backpack wallet
from the header.

### 2. Open the launch form

Go to **`/launch`** (the "Rain" flow), or click **Launch** in the header. The form
mirrors the parameters above:

1. **Token pair** - pick the base (X) and quote (Y) mints. Same-mint and
   Token-2022 mints are blocked with a clear message. If you are launching a
   brand-new token, the optional metadata uploader attaches a logo/name; skip it
   and the symbol falls back honestly to the on-chain short mint.
2. **Bin step** - choose a preset (e.g. `4`).
3. **Base fee tier** - the swap fee (e.g. `0.04%` = 4 bps).
4. **Your protocol fee** - your creator cut OF the swap fee (e.g. `20%`). The form
   shows what that works out to as a fraction of each trade (tiny, because it is
   a fraction of the fee, not the trade).
5. **Initial price** - type the quote-per-base price. The form resolves it to an
   **active bin** and shows the **resolved bin price** back, plus the derived
   **pool address**. Use the estimated-market-price shortcut if both tokens are
   priced.

The form refuses to build if a pool already exists for that pair and bin step, so
you never waste a fee re-initializing.

### 3. Sign and confirm

Click **Create pool**. Your wallet prompts **twice**:

- **First signature** - the create transaction: the CU budget, the two pool-vault
  ATA creations, and `initialize_pool`. The app polls the signature status to
  confirm (it does not trust a dropped WebSocket notification), then shows the
  pool as live with you as its authority.
- **Second signature (best effort)** - `init_pool_treasury`. If you reject or it
  fails, the pool is still live; the UI tells you honestly that the treasury was
  not set up and the 1% platform cut has no destination until it is. You can set
  it up later.

On success the app links to **`/pool/<address>?action=add`** so you can seed
liquidity immediately.

### 4. Seed liquidity

On the pool page (the `?action=add` deep link opens the add panel):

1. Choose a **strategy** - `spot` (uniform), `curve` (concentrated at the price),
   `bidask` (concentrated at the edges), or `full`.
2. Set a **range** (how many bins on each side of the active bin) and the amounts
   of base/quote to deposit.
3. The panel previews the exact shares minted and reserves pulled (the same math
   the program runs), creating the bin array and your position automatically if
   they do not exist yet. If SOL is a leg, it wraps/unwraps wSOL for you and
   reserves a little SOL for fees and rent.

Sign, confirm, and your market is live and tradeable.

### 5. Trade against it

Go to **`/trade/<address>`** and use the swap widget, or send a swap from any
client (see Path B, step 5). The widget quotes off-chain, applies your slippage
tolerance, and builds the swap with the correct compute budget and bin arrays.

That is the whole loop: launch, seed, trade, all client-side and non-custodial.

---

## Path B: launch with the SDK directly

Same three on-chain steps, built and sent from a Node script with a keypair. This
is the path for bots, CI, scripted launches, or any custom app. Everything below
uses `@ponkrain/sdk`; the SDK never holds a key, it hands you unsigned
instructions and you sign them.

### 0. Setup

Install the SDK (in a fresh project, or use the workspace one):

```bash
pnpm add @ponkrain/sdk @solana/web3.js
```

Load a funded keypair for the cluster you target (a local validator or devnet
until the audit). The examples assume:

```ts
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  RainClient,
  computeActiveBinId,
  priceOfBin,
  poolPda,
} from "@ponkrain/sdk";

// A reachable RPC where the Ponk Clouds program is deployed.
const connection = new Connection("http://127.0.0.1:8899", "confirmed");

// Your funded launch keypair (becomes the pool authority).
const authority = Keypair.fromSecretKey(/* your secret key bytes */);

const client = new RainClient({ connection });
```

`RainClient` wraps the connection and exposes the full lifecycle. Each mutating
method returns instructions (or a transaction) plus derived addresses and never
auto-signs.

### 1. Choose parameters and resolve the active bin

Decide the pair, bin step, fees, and initial price, then turn the human price into
the `active_bin_id` the program stores. The mints determine the decimals the
price conversion needs.

```ts
// X = base, Y = quote. NOT reordered for you.
const mintX = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL (9 dp)
const mintY = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC (6 dp)
const decimalsX = 9;
const decimalsY = 6;

const binStep = 4;          // bps; part of the pool PDA seed
const swapFeeBps = 4;       // 4 bps swap fee
const protocolFeeBps = 2000; // your cut: 20% OF the swap fee

const initialPrice = 150;   // quote per base (USDC per SOL)

// Resolve the human price to the discrete active bin (null if non-positive).
const activeBinId = computeActiveBinId(
  initialPrice,
  binStep,
  decimalsX,
  decimalsY,
);
if (activeBinId === null) throw new Error("invalid initial price");

// The grid is discrete, so confirm the REAL opening price of that bin.
const resolvedPrice = priceOfBin(activeBinId, binStep, decimalsX, decimalsY);
console.log(`active bin ${activeBinId}, opens at ~${resolvedPrice} USDC/SOL`);
```

> Token-2022 mints are not supported. The on-chain `initialize_pool` would fail
> on the vault constraint; reject such mints (check the mint account's owner is
> the classic SPL Token program) before building, exactly as the scaffold does.

### 2. Build the launch transactions

`client.rain(...)` validates the fee caps and bin step locally (throws on a bad
config), then returns the create bundle, the separate treasury instruction, and
the derived pool address. Nothing is signed or sent.

```ts
const { ixs, treasuryIx, pool } = client.rain({
  authority: authority.publicKey,
  mintX,
  mintY,
  binStep,
  swapFeeBps,
  protocolFeeBps,
  activeBinId,
});
// `ixs` = [ setComputeUnitLimit(80k), createAta(vaultX), createAta(vaultY), initialize_pool ]
// `treasuryIx` = init_pool_treasury (build it into its OWN transaction)
console.log("pool address:", pool.toBase58());
```

The pool address is deterministic, so you can compute it ahead of time with
`poolPda(mintX, mintY, binStep)` and check whether one already exists
(`client.getPool(mintX, mintY, binStep)` returns `null` when it does not). Refuse
to re-launch an existing pool: `initialize_pool` would fail on-chain and waste the
fee.

### 3. Sign, send, and confirm

Sign with your keypair and send. Use the SDK's `sendAndConfirm`, which sets the
blockhash and fee payer if unset and confirms by **polling signature status**
(not the WebSocket confirmation, which public RPCs routinely drop).

```ts
// --- Transaction 1: create the pool ---
const createTx = new Transaction().add(...ixs);
const createSig = await client.sendAndConfirm(createTx, async (tx) => {
  tx.partialSign(authority);
  return tx;
});
console.log("pool created:", createSig);

// --- Transaction 2 (best effort): the per-pool treasury ---
// Keep it SEPARATE so a treasury failure never undoes the (confirmed) pool.
try {
  const treasuryTx = new Transaction().add(treasuryIx);
  const treasurySig = await client.sendAndConfirm(treasuryTx, async (tx) => {
    tx.partialSign(authority);
    return tx;
  });
  console.log("treasury initialized:", treasurySig);
} catch (err) {
  // The pool is live regardless; the 1% platform cut just has no destination
  // until the treasury exists. It can be initialized later.
  console.warn("treasury init skipped:", (err as Error).message);
}
```

The pool now exists with you as its authority. It is empty until you seed it.

### 4. Seed the active bin with liquidity

A market needs liquidity in (at least) the active bin before swaps can fill. Load
the deposit context (does the bin array exist? does your position exist?), then
assemble the full single-bin add bundle, which prepends exactly the init
instructions it needs.

```ts
// Deposit amounts in BASE UNITS (lamports for SOL, 1e6 for USDC).
const amountX = 1_000_000_000n; // 1 SOL
const amountY = 150_000_000n;   // 150 USDC

// Read whether the bin array / position already exist for the active bin.
const ctx = await client.loadDepositContext(
  mintX,
  mintY,
  binStep,
  authority.publicKey,
  activeBinId,
);

// Preview the EXACT shares minted and reserves pulled (matches on-chain).
const preview = client.previewDeposit(
  { totalShares: ctx.slot.totalShares, reserveX: ctx.slot.reserveX, reserveY: ctx.slot.reserveY },
  amountX,
  amountY,
);
console.log("shares minted:", preview.sharesMinted.toString());

// Build [ initBinArray?, initPosition?, addLiquidity ] for the single active bin.
const addIxs = client.addLiquidity({
  owner: authority.publicKey,
  mintX,
  mintY,
  binStep,
  lower: activeBinId,   // single-bin position keyed by lower === binId
  binId: activeBinId,
  amountX,
  amountY,
  binArrayExists: ctx.binArrayExists,
  positionExists: ctx.positionExists,
});

const addTx = new Transaction().add(...addIxs);
const addSig = await client.sendAndConfirm(addTx, async (tx) => {
  tx.partialSign(authority);
  return tx;
});
console.log("liquidity added:", addSig);
```

To deposit across a **range** rather than a single bin, use
`client.planRange(activeBinId, spread, totalX, totalY, strategy)` to split the
amounts across bins for a `spot` / `curve` / `bidask` / `full` shape, then build
an add bundle per bin (base fills bins above the price, quote fills bins below;
the active bin is the one mixed bin). If SOL is a leg, wrap it first with the
SDK's `wrapSolIxs` and close the wSOL account afterward with `closeWsolIx`, and
size a "max" deposit with `maxSpendableBaseUnits` so enough SOL is left for fees
and rent.

### 5. Swap against your new market

With the active bin funded, the market is tradeable. Quote off-chain (the result
equals the on-chain output), apply a slippage tolerance, build, and send. Here a
trader sells base for quote (`xForY = true`, price walks down):

```ts
const trader = authority; // or any funded keypair

const quote = await client.quoteSwap({
  mintX,
  mintY,
  binStep,
  amountIn: 100_000_000n, // 0.1 SOL in
  xForY: true,
});
console.log("expected out:", quote.amountOut.toString());

const { ixs: swapIxs, minOut } = await client.swap({
  user: trader.publicKey,
  mintX,
  mintY,
  binStep,
  amountIn: 100_000_000n,
  xForY: true,
  slippageBps: 50, // 0.50% tolerance -> floors min_out
  quote,           // reuse the quote to skip a second RPC round-trip
});
console.log("min out (slippage floor):", minOut.toString());

const swapTx = new Transaction().add(...swapIxs);
const swapSig = await client.sendAndConfirm(swapTx, async (tx) => {
  tx.partialSign(trader);
  return tx;
});
console.log("swap landed:", swapSig);
```

> The trader needs an associated token account for both mints. When SOL is the
> input leg, wrap it into wSOL first (`wrapSolIxs`) and unwrap any remainder after
> (`closeWsolIx`); the scaffold's swap widget does this automatically.

That completes the SDK loop: launch, seed, swap.

---

## After launch: operating the pool

As the pool authority you can later:

- **Claim your creator protocol fees** with `client.claimProtocolFees(...)`. The
  accrued amounts are readable off the decoded pool (`protocolFeeX` /
  `protocolFeeY`).
- **Claim the platform treasury fees** to the configured treasury wallet with
  `client.claimTreasuryFees(...)` (once the treasury PDA exists).
- **Read live state** any time: `client.getPool(...)`,
  `client.getBinDistribution(info, radius)` for the bin book,
  `client.getPositions(info, owner)` for an owner's positions, and
  `client.getActivity(info, limit)` for recent pool activity.

LPs can always exit (`client.removeLiquidity(...)` then
`client.closePosition(...)` once a position is empty), even if the authority
pauses the pool.

## Troubleshooting

- **`Ponk Rain: bin step must be a positive u16` / fee out of range.** The local
  validation in `client.rain(...)` caught a bad config. Bin step must be `> 0`;
  swap fee `<= 1000` bps; creator protocol fee `<= 5000` bps.
- **"a Ponk Clouds pool already exists for this pair and bin step."** A pool's
  address is deterministic from `(mintX, mintY, binStep)`. Change the bin step or
  the mint order, or use the existing pool. Check with
  `client.getPool(mintX, mintY, binStep)`.
- **Token-2022 mint rejected.** The program only supports classic SPL tokens. Use
  a classic-SPL mint for both legs.
- **Swap reverts with "the active bin is not in the loaded bin array" or fills
  nothing.** The active bin has no liquidity yet. Seed the active bin (step 4)
  before trading.
- **"output below minimum (slippage)."** The market moved between quoting and
  sending, or your slippage tolerance was too tight. Re-quote and/or raise
  `slippageBps`.
- **Transaction "expired" but actually landed.** Use the SDK's `sendAndConfirm`
  (it polls signature status instead of trusting a dropped WebSocket
  confirmation) rather than `connection.confirmTransaction`.
- **Wallet prompts only once in the scaffold.** The second prompt is the
  best-effort treasury init; if you reject it the pool is still live and you can
  initialize the treasury later.

## Next steps

- Get the repo running: [quickstart](./quickstart.md).
- Full SDK reference and the `RainClient` API:
  [`../packages/sdk/README.md`](../packages/sdk/README.md).
- App pages, configuration, and deploy:
  [`../scaffold/launch/README.md`](../scaffold/launch/README.md).
- Project overview and the honesty/safety guarantees: [`index.md`](./index.md).
