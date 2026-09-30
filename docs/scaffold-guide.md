# Ponk Rain scaffold guide

How to fork, customize, and ship `@ponkrain/launch`, the clone-and-run Next.js
launchpad and market UI in `scaffold/launch`. It is the reference frontend for
[Ponk Rain](./index.md), built entirely on [`@ponkrain/sdk`](../packages/sdk).

This guide assumes the app already runs. If it does not, start with the
[quickstart](./quickstart.md) (clone, install from the repo root, build the SDK,
copy `.env.example` to `.env.local`, `pnpm dev` on port 3100), then come back
here to make it yours.

> ponk.exchange was assessed by zauth (Vector) on 29 September 2026: a deep scan
> across 51 endpoints, 5 subdomains and 58 input vectors, every finding verified
> by browser-based proof of concept. 12 findings, no critical. The report is
> published in full at https://ponk.exchange/docs/audits
>
> Test against a local validator or devnet before you deploy capital, as you
> would with any on-chain program.
>
> Two rules run through the whole scaffold and you should preserve them in any
> fork: it is **non-custodial** (every mutating action returns unsigned
> instructions the user's wallet signs, the app never touches a private key) and
> it shows **no fabricated data** (a genuinely unknown indexed value renders
> `--`, never an invented number, and there are no "coming soon" stubs).

## Contents

- [Scaffold structure](#scaffold-structure)
- [The lib layer (where to wire things)](#the-lib-layer-where-to-wire-things)
- [Customizing pages](#customizing-pages)
- [Branding](#branding)
- [Wallet configuration](#wallet-configuration)
- [Storage adapters (token-metadata uploads)](#storage-adapters-token-metadata-uploads)
- [Pointing at your own RPC and indexer](#pointing-at-your-own-rpc-and-indexer)
- [The honesty rules a fork must keep](#the-honesty-rules-a-fork-must-keep)

## Scaffold structure

The app is a standard Next.js 14 App Router project under `scaffold/launch`. It
consumes `@ponkrain/sdk` through the workspace link (`"@ponkrain/sdk":
"workspace:*"` in its `package.json`) and OUR backend clouds API for indexed
reads. The on-chain plumbing (PDAs, decoders, swap/liquidity math, transaction
builders) all lives in the SDK; the app never re-derives a byte offset.

```
scaffold/launch/
  next.config.mjs          output: "standalone", outputFileTracingRoot -> repo root
  tailwind.config.ts       Theme wired to the CSS custom properties in globals.css
  postcss.config.mjs       Tailwind + autoprefixer
  tsconfig.json            Strict, ESM, "@/*" path alias -> src/*
  .env.example             Documented env template (copy to .env.local)
  public/                  Static assets; public/uploads is the local storage target
  src/
    app/                   App Router: pages + /api routes
      layout.tsx           Root server layout: fonts, globals.css, Providers, Header, Footer
      providers.tsx        "use client" boundary: WalletProvider + TanStack QueryClient
      globals.css          Tailwind layers + design tokens (CSS custom properties)
      (market)/page.tsx    Home / explore (server component)
      launch/page.tsx      Create a market (the "Rain" flow)
      trade/[pool]/page.tsx        Trading interface for one pool
      pool/[address]/page.tsx      Pool detail + liquidity
      portfolio/page.tsx           Connected-wallet portfolio
      api/metadata/route.ts        POST token-metadata upload (pluggable storage)
    components/
      layout/              Header, Footer
      wallet/              WalletProvider, WalletButton (the wallet-adapter stack)
      launch/              LaunchForm and friends (the create-market UI)
      swap/                SwapWidget, token pickers
      chart/               PriceChart (lightweight-charts), LiquidityChart
      pools/               PoolList, PoolCard, TokenIcon
      analytics/           StatBar, PoolAnalytics, RecentTrades
      portfolio/           PortfolioSummary, PnlChart, PositionsTable
      ui/                  Primitives: Card, Input, Stat (and Button/Skeleton)
    lib/
      sdk.ts               Single import surface for @ponkrain/sdk (re-export + spec aliases)
      connection.ts        Memoized web3.js Connection + the wallet-adapter endpoint
      config.ts            Static, non-secret config: brand, program id, presets, mints
      format.ts            Display helpers (formatUsd, shortenAddress, null -> "--")
      storage.ts           Pluggable StorageDriver + createStorage() factory
      (env.ts, api.ts, feed.ts as your backend wiring grows)
```

A few notes about the actual layout versus the design spec, so a fork is not
surprised:

- The upload route is `src/app/api/metadata/route.ts` (mounted at
  `POST /api/metadata`). Point any uploader you write at `/api/metadata`.
- `src/lib/storage.ts` is a single file that contains both the `StorageDriver`
  interface and the concrete `LocalFsDriver` and `S3Driver` classes, rather than
  a `storage/` directory of one-file-per-driver. The `createStorage()` factory
  selects between them.
- The wallet-adapter stack is composed in `src/components/wallet/WalletProvider.tsx`
  and surfaced through `src/app/providers.tsx`. `providers.tsx` imports
  `WalletProvider` from `@/components/wallet/WalletProvider`.

Everything compiles against the `"@/*"` path alias from `tsconfig.json`
(`"@/lib/config"` resolves to `src/lib/config.ts`), so imports in this guide use
that form.

## The lib layer (where to wire things)

Before touching pages or components, learn the four `lib` files you will edit
most. They are the seams the rest of the app is built on.

### `lib/sdk.ts` - the SDK boundary

Every component imports SDK functionality FROM `@/lib/sdk`, never from
`@ponkrain/sdk` directly. The module does two things:

1. `export * from "@ponkrain/sdk"` so the whole SDK surface (`poolPda`,
   `priceOfBin`, `binIdForPrice`, `previewDeposit`, `planRange`, `decodePool`,
   `discoverPools`, `quoteSwap`, `confirmSignature`, `RainClient`, ...) is available
   unchanged.
2. Adds thin, spec-named aliases where the design's public name differs from the
   SDK's: `initPoolVaultIxs(params)` delegates to the SDK's `createPoolIxs`, and
   `buildCloudsSwapIxs(params)` delegates to `buildSwapIxs`.

Keeping one boundary means if you swap the SDK or pin a fork, you change one
import path, not fifty. When you write a new component that needs the SDK, import
from `@/lib/sdk`.

### `lib/connection.ts` - the RPC connection

`ponkCloudsConnection()` returns a memoized `Connection` built from
`NEXT_PUBLIC_PONK_CLOUDS_RPC` at the `"confirmed"` commitment, and
`CLOUDS_RPC_ENDPOINT` is the same endpoint string the wallet-adapter
`ConnectionProvider` uses. The provider and the imperative tx-building path
therefore always agree on one cluster. Change the RPC via env, not by editing
this file (see [pointing at your own RPC](#pointing-at-your-own-rpc-and-indexer)).

### `lib/config.ts` - static, non-secret config

All compile-time constants and NEXT_PUBLIC-derived values: the brand name, the
program id (resolved from `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` with a fallback to
the real deployed default), the canonical mints (wSOL, USDC), and every create-
market preset (`BIN_STEP_PRESETS`, `BASE_FEE_PRESETS`, `PROTOCOL_FEE_PRESETS`
and their `DEFAULT_*`). This is the single place to retune the launch flow; the
`LaunchForm` and the pool lists read from here so they stay in lockstep. It reads
no secrets, so it is safe to import from both server and client components.

### `lib/format.ts` - the honesty layer

`formatUsd`, `formatNumber`, `formatPct`, `shortenAddress`, and the `--` renderer
for null/undefined live here, plus the `toBaseUnits` / `fromBaseUnits` bridges to
the SDK codec. Route every money/number field through these so the no-fabrication
rule is enforced at the formatting leaf: a null indexed value becomes `--`, never
`$0.00` or a guess.

## Customizing pages

The pages are deliberately thin: a server component fetches and a client
component renders interactively. To change one page, you usually edit its
component(s) under `src/components`, not the route file.

| Route | File | What it renders | Customize by editing |
| --- | --- | --- | --- |
| `/` | `app/(market)/page.tsx` | Hero + platform `StatBar` + `PoolList` | `components/analytics/StatBar`, `components/pools/PoolList` |
| `/launch` | `app/launch/page.tsx` | The create-market form | `components/launch/LaunchForm`, presets in `lib/config.ts` |
| `/trade/[pool]` | `app/trade/[pool]/page.tsx` | `PriceChart` + `RecentTrades` + `SwapWidget` | `components/swap/SwapWidget`, `components/chart/PriceChart` |
| `/pool/[address]` | `app/pool/[address]/page.tsx` | Header + `LiquidityChart` + analytics + add/remove panels | `components/chart/LiquidityChart`, the liquidity panels |
| `/portfolio` | `app/portfolio/page.tsx` | Summary + PnL chart + positions | `components/portfolio/*` |

Common edits:

- **Retune the launch presets.** Change `BIN_STEP_PRESETS`, `BASE_FEE_PRESETS`,
  `PROTOCOL_FEE_PRESETS`, or any `DEFAULT_*` in `lib/config.ts`. The form chips
  and defaults update without touching `LaunchForm`. The SDK validates the same
  caps on-chain (`swapFee <= 1000`, `protocolFee <= 5000`, `binStep > 0`), so a
  preset outside the caps will fail in `validateRainParams` before a tx is built.
- **Change the default quote token.** `USDC_MINT_STR` / `USDC_DECIMALS` in
  `lib/config.ts` define the default quote. Replace them to default new markets
  to a different quote mint.
- **Add or remove a nav link.** Edit `components/layout/Header.tsx`. It is a
  presentational, active-route-aware client component.
- **Add a page.** Create `app/<route>/page.tsx`. Server components can fetch from
  your indexer; anything that needs the wallet or a hook must be a `"use client"`
  component nested inside (the provider stack is mounted once in the root layout,
  so `useWallet()` / `useConnection()` work anywhere under it).

Do NOT add a control you have not wired. A disabled "coming soon" button or a
mocked metric violates the kit's honesty rule; build the feature or omit the
control and render `--` for the value.

## Branding

The product name is **Ponk Rain** (the act of creating a Ponk Clouds DLMM is
"raining" one). To rebrand a fork:

1. **Names.** Edit `BRAND_NAME` and `VENUE_NAME` in `lib/config.ts`. These flow
   into the `Header`, `Footer`, and copy that imports them. Also update the
   page metadata in `app/layout.tsx` (`metadata.title`, `description`,
   `applicationName`, `openGraph`, `twitter`) since those are static strings.

2. **Colors and theme.** The palette is a set of CSS custom properties in
   `src/app/globals.css` (`--bg`, `--panel`, `--elevated`, `--line`, `--fg`,
   `--muted`, `--pink`, `--pink-fg`, `--positive`, `--negative`), exposed to
   Tailwind as named colors in `tailwind.config.ts` (`bg-bg`, `border-line`,
   `text-pink`, ...). `--pink` is the brand accent. Change the variable values in
   `globals.css` and the whole UI re-themes; you rarely touch `tailwind.config.ts`
   unless you add a new token name. The same names work in utility classes and
   raw CSS, so there is one source of truth.

3. **Fonts.** `app/layout.tsx` loads Inter (`--font-sans`) and JetBrains Mono
   (`--font-mono`) via `next/font`, bound to the CSS variables the theme reads.
   Swapping a typeface is a one-line change there; the rest of the app references
   `font-sans` / `font-mono`.

4. **Logo and static assets.** Drop your mark in `public/` and reference it from
   the `Header`/`Footer`. (The PONK brand assets in the wider monorepo live under
   `assets/brand/`; a fork should supply its own.)

5. **Solscan / explorer links.** `solscanTxUrl` and `solscanAddressUrl` in
   `lib/config.ts` build the explorer links used by the trade tape and create
   flow. Repoint them if you prefer a different explorer.

Because the brand strings and the accent color each live in exactly one place,
a full rebrand is a handful of edits, not a find-and-replace across components.

## Wallet configuration

The wallet stack is the standard `@solana/wallet-adapter` set:

- `components/wallet/WalletProvider.tsx` composes
  `ConnectionProvider` (endpoint = `CLOUDS_RPC_ENDPOINT` from `lib/connection.ts`)
  -> `WalletProvider` (the adapters, with `autoConnect`) ->
  `WalletModalProvider` (the `@solana/wallet-adapter-react-ui` modal).
- `components/wallet/WalletButton.tsx` is a styled wrapper over
  `WalletMultiButton` that shows the truncated pubkey when connected and opens
  the modal when not. It is the single connect entry point reused in the `Header`
  and in pre-connect empty states.
- `app/providers.tsx` mounts `WalletProvider` (outermost) around the TanStack
  `QueryClientProvider`, so any query/mutation hook can read the connected
  wallet. The wallet stack must wrap React Query, not the other way around.

To change which wallets are offered:

1. Edit the adapter list in `components/wallet/WalletProvider.tsx`. The default
   set is Phantom, Solflare, and Backpack, imported from
   `@solana/wallet-adapter-wallets`. Add or remove adapters there.
2. Keep `SUPPORTED_WALLETS` in `lib/config.ts` in sync. It lists the adapter
   `name` strings (`"Phantom"`, `"Solflare"`, `"Backpack"`) the UI matches
   against the connected wallet; it is documentation/UX, the actual capability is
   the adapter list in step 1.

Note that many modern wallets (including Phantom, Solflare, and Backpack)
register themselves via the Wallet Standard, so wallet-adapter discovers them
even if they are not in the explicit list; the explicit list guarantees they are
always offered and ordered.

The RPC the wallet connects to is `NEXT_PUBLIC_PONK_CLOUDS_RPC`, surfaced as
`CLOUDS_RPC_ENDPOINT`. The provider and the SDK transaction path read the same
endpoint, so they never drift onto different clusters. Do not hardcode an RPC in
the provider; set the env var.

A mutating flow always follows the non-custodial pattern: build instructions
from `@/lib/sdk` (e.g. `initPoolVaultIxs`, `buildCloudsSwapIxs`,
`addLiquidityIx`), assemble a `Transaction`, set `feePayer` + a fresh blockhash,
ask the wallet to `signTransaction`, send the raw bytes, and confirm by polling
with the SDK's `confirmSignature` (which polls signature status rather than trusting a
dropped WebSocket notification). The app never holds a key.

## Storage adapters (token-metadata uploads)

When a creator gives a new token a logo + name + symbol, the launcher posts it to
`POST /api/metadata` (`src/app/api/metadata/route.ts`). The route validates the
payload (image type allow-list, 1 MiB cap, bounded text fields), writes the image
and a companion Metaplex-style JSON document through a pluggable storage driver,
and returns `{ uri, image }` (the metadata JSON URL and the public image URL, or
`image: null` when no logo was supplied). It accepts both `multipart/form-data`
and `application/json` (base64 image) bodies, and runs on the Node.js runtime
because the drivers use `node:crypto` / `node:fs`.

The storage backend is chosen at request time by `createStorage()` in
`lib/storage.ts`, keyed off the `TOKEN_STORAGE_DRIVER` env var.

### Local filesystem (default, clone-and-run)

`TOKEN_STORAGE_DRIVER=local` (or unset) selects `LocalFsDriver`. It writes bytes
under `public/uploads/<key>` and returns a same-origin `/uploads/<key>` URL.
Next serves `public/` statically, so the URL resolves immediately with no
external account. This is a real implementation (the bytes hit disk), and it is
the right default for local development and single-node self-hosting. It is NOT
durable across a multi-node deploy or an ephemeral container filesystem, so use
S3/R2 in production.

### S3 / Cloudflare R2 (production)

`TOKEN_STORAGE_DRIVER=s3` selects `S3Driver`. It performs a real, SigV4-signed
`PUT` over `fetch` against any S3-compatible endpoint, computing the signature
with Node's built-in crypto so there is no `aws-sdk` dependency. The same signing
works against AWS S3, Cloudflare R2, Backblaze B2, and MinIO. Required env (the
factory throws at construction naming any missing one, so a misconfigured deploy
fails loudly at the first upload):

| Variable | Required | Purpose |
| --- | --- | --- |
| `STORAGE_S3_BUCKET` | yes | Bucket name |
| `STORAGE_S3_REGION` | yes | Region (use `auto` for R2) |
| `STORAGE_S3_ACCESS_KEY_ID` | yes | Access key id |
| `STORAGE_S3_SECRET_ACCESS_KEY` | yes | Secret access key |
| `STORAGE_S3_ENDPOINT` | no | S3-compatible endpoint; defaults to `https://s3.<region>.amazonaws.com`. Set this for R2 / B2 / MinIO. |
| `STORAGE_PUBLIC_BASE_URL` | no | Public base URL (CDN / custom domain) the returned URI is built from. When unset, the signed endpoint path is returned, which is correct for a public-read bucket. |

The object is written with `x-amz-acl: public-read`. R2 ignores object ACLs, so
on R2 make the bucket public (or attach a public dev/custom domain) and set
`STORAGE_PUBLIC_BASE_URL` to it.

### Writing your own driver

Implement the `StorageDriver` interface from `lib/storage.ts`:

```ts
export interface StorageDriver {
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ uri: string }>;
}
```

The contract is: persist `bytes` under the caller-chosen relative `key` (already
sanitized and namespaced, e.g. `tokens/<sha256>.png`), make the object publicly
readable, and return its fetchable public URL. Then add a `case` for your driver
name in the `createStorage()` switch. The factory throws on an unrecognized
`TOKEN_STORAGE_DRIVER` value rather than silently falling back, so a typo
surfaces instead of quietly using local disk in production.

> `.env.example` mentions an `ipfs` value for completeness, but the shipped
> `createStorage()` handles `local` and `s3`. If you want IPFS, add an `IpfsDriver`
> implementing the interface and an `ipfs` case in the factory. Do not leave a
> non-functional `ipfs` selection in a fork; either implement it or remove the
> mention so the option is honest.

## Pointing at your own RPC and indexer

A fork has two external dependencies: a Solana RPC (for building and sending
transactions) and a clouds indexer API (for the `/clouds/*` reads the lists,
charts, and portfolio render). Both are configured purely through env in
`.env.local` (copied from `.env.example`); the variables are validated at boot so
a missing required one fails fast with a clear message.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_PONK_CLOUDS_RPC` | client | Solana RPC the wallet/SDK use to build and send transactions. Default `https://api.mainnet-beta.solana.com`. |
| `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` | client | Program id override. Defaults to the real deployed program. Set only for a local/devnet redeploy. |
| `NEXT_PUBLIC_API_URL` | client | Backend clouds API base. The browser opens the SSE feed (`EventSource`) against this directly, so it must be reachable from the client. |
| `API_URL` | server | Backend clouds API base for the same-origin `/api/*` proxy routes and server components. May be an internal address; falls back to `NEXT_PUBLIC_API_URL` if unset. |

If `NEXT_PUBLIC_API_URL` does not point at a live indexer, the UI still renders
but list/chart data shows `--` (honest empty state) rather than fabricated
numbers. Wallet-side actions (launch, swap, liquidity) work as long as
`NEXT_PUBLIC_PONK_CLOUDS_RPC` is a reachable RPC with the program deployed.

For local development against a validator, set
`NEXT_PUBLIC_PONK_CLOUDS_RPC=http://127.0.0.1:8899`,
`NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` to your locally deployed id, and point both
`NEXT_PUBLIC_API_URL` and `API_URL` at your local indexer. The SDK derives every
PDA and account offset from the program id, so a redeployed local id flows
through cleanly. See the [quickstart](./quickstart.md) for the full local-validator
walkthrough and the production build/deploy steps (`output: "standalone"`).

## The honesty rules a fork must keep

These are load-bearing, not stylistic. Preserve them or the kit stops being
trustworthy:

- **Non-custodial.** Build instructions, hand them to the wallet to sign, send
  and poll-confirm. Never collect, derive, or transmit a private key.
- **No fabrication.** On-chain reads return real values or `null`/`0` (an empty
  bin reads as zero reserves, not a guess). Where an indexed value is genuinely
  unknown the UI renders `--` (route it through `lib/format.ts`). No mocked data.
- **No "coming soon".** Do not ship a disabled or placeholder control. Build the
  feature for real or omit the control entirely.
- **Keep the footer honest.** The `Footer` carries the assessment link
  and the program id; keep that visible until the program is audited.
- **No em dashes.** The kit's copy uses hyphens and commas, never the em dash
  character, in code, comments, JSX, and docs alike.

## Where to go next

- SDK reference and the high-level `RainClient`: [`../packages/sdk/README.md`](../packages/sdk/README.md).
- App-specific README (scripts, deploy, layout): [`../scaffold/launch/README.md`](../scaffold/launch/README.md).
- Full clone-install-run walkthrough: [`./quickstart.md`](./quickstart.md).
- Project overview, monorepo layout, and audience: [`./index.md`](./index.md).
