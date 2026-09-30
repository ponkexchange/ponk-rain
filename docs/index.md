# Ponk Rain

**Ponk Rain** is the launch kit and SDK for [Ponk Clouds](https://ponk.exchange),
PONK's own bin-based DLMM (Discretized Liquidity Market Maker) AMM on Solana.
It is everything you need to launch a concentrated-liquidity market, seed it
with liquidity, trade against it, and read its on-chain state, driven entirely
from a wallet over `@solana/web3.js`.

The kit wraps the real, deployed Ponk Clouds program at
`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`.

> **UNAUDITED.** The Ponk Clouds program holds user funds and has not passed an
> external security audit. Run it against a local validator or devnet until that
> changes. Do not deposit funds you are not prepared to lose.
>
> The ponk.exchange web application, API and MCP server were assessed separately
> by zauth (Vector) on 29 September 2026, published in full at
> [ponk.exchange/docs/audits](https://ponk.exchange/docs/audits). That assessment
> did not read this program and says nothing about its bin math, its swap
> accounting or its vault invariants.

## What is Ponk Clouds

Ponk Clouds is a bin-based DLMM AMM, in the same family as Meteora DLMM. Instead
of a single constant-product curve, liquidity is sliced into discrete price
**bins**. Each bin holds reserves at a fixed price and trades along a
constant-sum curve, so within a bin there is zero slippage; price only moves as
a swap walks from one bin to the next. Liquidity providers choose exactly which
bins (which price range) to fund, giving the capital efficiency of concentrated
liquidity.

The defining property is the fee model:

- **Zero protocol fee at the AMM level.** The program itself takes no cut of the
  trade. The entire swap fee is set per pool by the pool creator.
- That swap fee is then split three ways: the pool **creator's** protocol cut
  (bps OF the swap fee, capped so creators can never take the whole fee, LPs
  always keep at least half), a small flat **platform treasury** cut (default
  1% of the swap fee to the PONK treasury), and the remainder to **LPs**. With a
  creator protocol fee of 0, LPs keep 100% of the swap fee minus the treasury
  cut.

Because the protocol fee lives in bps OF the swap fee rather than of the trade,
real numbers are tiny: a 4 bps swap fee with a 300 bps creator cut works out to
about 0.0012% of each trade. The kit surfaces these honestly everywhere rather
than overstating them.

Key on-chain parameters the kit respects, ported verbatim from the program:

| Parameter | Value | Meaning |
| --- | --- | --- |
| Program id | `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M` | The deployed Ponk Clouds program |
| Bins per array | 70 | Each `BinArray` is a 70-bin price window |
| Max swap fee | 1000 bps | Hard cap a creator can set as the swap fee |
| Max protocol fee | 5000 bps | Cap on the creator's cut OF the swap fee (LPs keep >= half) |
| Max treasury fee | 5000 bps | Cap on the platform cut OF the swap fee |
| Default treasury fee | 100 bps | 1% of the swap fee, to the PONK treasury, by default |
| Max bins per swap | 28 | Compute-bounded walk limit per swap |
| Max bin arrays per swap | 2 | The named array plus one remaining array (140 contiguous bins) |

These come straight from the program's `lib.rs` and `state.rs`, and from the
`clouds-math` reference crate, so an off-chain quote built with the SDK matches
the on-chain result.

## What Ponk Rain gives you

Ponk Rain turns that program into something you can build on without
re-deriving the byte layout, the PDA seeds, or the swap math by hand.

- **A TypeScript SDK** (`@ponkrain/sdk`) that derives every program-derived
  address, decodes every account (pools, bin arrays, positions, treasuries),
  reproduces the on-chain swap and liquidity math exactly off-chain so you can
  compute an honest `minOut`, and builds the raw transactions a wallet signs:
  launch a market, swap, open/add/remove/close LP positions, and claim fees.
- **A clone-and-run frontend** (`@ponkrain/launch`) that is the reference
  product built on that SDK: explore and sort live pools, launch a new market,
  trade with a live price chart and trade tape, manage liquidity around the
  active bin, and track a wallet's portfolio and PnL.

Two design rules run through the whole kit:

- **Non-custodial.** Every mutating call returns unsigned instructions or a
  `Transaction`. The SDK never holds, derives, or asks for a private key, you
  sign with your own wallet or keypair.
- **No fabrication.** On-chain reads return real values or `null`/`0`. Empty
  bins read as zero reserves, not guesses. Where an indexed value is genuinely
  unknown the UI renders `--`. There are no "coming soon" controls and no mocked
  data anywhere in the kit.

## Monorepo layout

Ponk Rain is a pnpm workspace (`pnpm-workspace.yaml`) with two workspace globs,
`packages/*` and `scaffold/*`:

```
ponk-rain/
  package.json            Workspace root: build / dev / typecheck / lint scripts
  pnpm-workspace.yaml      Workspace globs: packages/* and scaffold/*
  tsconfig.base.json       Shared strict TypeScript base config
  LICENSE                  Apache-2.0
  docs/                    This documentation
    README.md               Docs index
    index.md                This file
  packages/
    sdk/                   @ponkrain/sdk - the TypeScript SDK
      src/
        constants.ts        Program id, addresses, discriminators, magic numbers
        version.ts          Version / build metadata (dependency-free)
        idl/
          ponk_clouds.ts    Anchor IDL data export + error-code map
        pda.ts              PDA and ATA derivation (pool, bin array, position, treasury, vault)
        codec.ts            Little-endian byte encode/decode helpers
        types.ts            Public TypeScript interfaces and type aliases
        math/
          index.ts          Math barrel re-export
          price.ts          Bin pricing (display floats + exact Q64.64 integer)
          swap.ts           Exact swap math: within-bin fill + cross-bin walk
          liquidity.ts      Exact deposit/withdraw share math + range planner
        pool.ts             Decode and read/discover pool state from chain
        rain/
          createPool.ts     Build the market-launch transactions (the "Rain" flow)
          index.ts          Rain launch barrel re-export
        swap.ts             Build and quote swap transactions
        position.ts         Open/fund/close LP positions, wSOL helpers
        fees.ts             Authority-only fee-claim transactions and reads
        confirm.ts          Send/confirm helpers (status polling, tx packing)
        client.ts           RainClient: the high-level entry point
        index.ts            Public barrel re-export
  scaffold/
    launch/                @ponkrain/launch - the Next.js launchpad and market UI
      src/
        app/                App Router pages (home, /launch, /explore, /trade, /pool, /portfolio) + /api proxy routes
        components/         UI: wallet, layout, launch, swap, charts, pools, analytics, portfolio, primitives
        lib/                SDK wrapper, RPC connection, API client, SSE feed, env, config, storage, formatting
```

- **`packages/sdk`** is the library. It is environment-agnostic: it depends only
  on `@solana/web3.js`, builds all transactions from raw instructions (no Anchor
  at runtime), ships ESM + CJS + type declarations, and takes a program-id
  override only through an explicit options object, never an env var. This is
  the piece you depend on from any app, browser or Node. See
  [`../packages/sdk/README.md`](../packages/sdk/README.md).
- **`scaffold/launch`** is the reference app. It consumes `@ponkrain/sdk` via the
  workspace (`@ponkrain/sdk: workspace:*`) plus OUR backend clouds API for
  indexed reads (pools, swaps, stats, portfolio) and an SSE feed for live ticks.
  It is meant to be forked: point it at your own RPC and indexer and ship. See
  [`../scaffold/launch/README.md`](../scaffold/launch/README.md).

Source of truth for the on-chain program itself lives in a separate repo
(`ponk-clouds`): the Anchor program (`programs/ponk-clouds/src/lib.rs`,
`state.rs`) and the pure `clouds-math` crate (`price`, `swap`, `liquidity`,
`router`). The SDK ports those values and math faithfully so this kit and the
chain agree.

## Who Ponk Rain is for

- **Token teams and creators** who want to launch a real DLMM market for a token
  in minutes, fork `@ponkrain/launch`, set the bin step, swap fee, creator cut,
  and initial price, and have a working trade and liquidity UI from the first
  commit. No backend wiring for the launch flow itself; it builds and signs the
  pool-create transactions client-side.
- **Frontend and product developers** building a custom trading or liquidity
  interface who want the on-chain plumbing solved. Depend on `@ponkrain/sdk`,
  call `RainClient`, and own the UX. Every mutating method hands you the
  instructions and derived addresses and lets you keep custody of signing.
- **Liquidity providers and integrators** who need to read pool, bin, and
  position state, compute exact quotes and deposit previews off-chain, and plan
  a liquidity range (spot / curve / bidask / full) around the active bin. The
  SDK's math matches the program, so a preview equals what lands on-chain.
- **Bot and infrastructure builders** who want a small, dependency-light Node
  library to derive addresses, decode accounts, quote swaps, and build raw
  transactions, with battle-tested send/confirm helpers that poll signature
  status instead of trusting a dropped WebSocket confirmation.

## Where to go next

- SDK reference and quick start: [`../packages/sdk/README.md`](../packages/sdk/README.md)
- Launchpad scaffold guide: [`../scaffold/launch/README.md`](../scaffold/launch/README.md)
- The high-level entry point in the SDK is `RainClient` (`packages/sdk/src/client.ts`).
