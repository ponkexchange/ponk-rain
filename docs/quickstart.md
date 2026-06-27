# Ponk Rain quickstart

Get the **Ponk Rain** monorepo cloned, installed, configured, and running, from
zero to a launchpad UI on `http://localhost:3100`.

Ponk Rain is the launch kit for [Ponk Clouds](https://ponk.exchange), PONK's own
bin-based DLMM AMM on Solana with **zero protocol fee at the AMM level**. The
repo is a small pnpm workspace with two members:

| Workspace member | Package | What it is |
| --- | --- | --- |
| `packages/sdk` | `@ponkrain/sdk` | TypeScript SDK: PDAs, account decoders, exact off-chain swap/liquidity math, and raw `@solana/web3.js` transaction builders. Wraps the deployed program `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`. |
| `scaffold/launch` | `@ponkrain/launch` | Clone-and-run Next.js 14 launchpad + market UI, built entirely on `@ponkrain/sdk`. |

> **UNAUDITED.** The Ponk Clouds program
> (`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`) has not been audited. Run it
> against a local validator or devnet until that changes. Do not deposit funds
> you are not prepared to lose.

## Prerequisites

- **Node >= 20.** The repo pins Node 20 via `.nvmrc`. If you use `nvm`, run
  `nvm use` at the repo root. (Newer Node, e.g. 22, also works.)
- **pnpm 9+.** The workspace declares `packageManager: pnpm@9.7.0`. The simplest
  way to get the right pnpm is Corepack, which ships with Node:

  ```bash
  corepack enable
  ```

  Corepack will provision the pinned pnpm the first time you run a `pnpm`
  command in the repo. (pnpm 10/11 also work.)
- A **Ponk Clouds RPC** endpoint for building and sending transactions (a local
  validator, devnet, or mainnet). Only needed when you actually connect a wallet
  and send a transaction, not to start the dev server.
- A reachable **clouds API** (the indexer that serves the `/clouds/*` reads the
  UI lists, charts, and portfolio call). Only needed for live data in the UI.

## 1. Clone

```bash
git clone <your-ponk-rain-remote> ponk-rain
cd ponk-rain
```

> This project is self-hosted. There are no GitHub workflows in the repo and you
> deploy from your own infrastructure. Substitute your own git remote above.

## 2. Install

Install once from the **repo root**. This is a pnpm workspace, so installing at
the root links `@ponkrain/sdk` into the scaffold (`@ponkrain/sdk: "workspace:*"`)
and resolves every dependency for both members in a single pass.

```bash
# from the ponk-rain repo root
corepack enable      # if you have not already
pnpm install
```

Do not run `npm install` or `pnpm install` from inside `scaffold/launch`; the
workspace link only resolves correctly from the root.

## 3. Build the SDK

The scaffold transpiles the SDK's TypeScript source directly during `pnpm dev`,
so for a quick dev-only spin you can skip this step. But a **built** SDK
(`packages/sdk/dist`) is required for a production `next build`, and building it
once now avoids a surprise later:

```bash
pnpm --filter @ponkrain/sdk run build
```

This runs `tsup` and emits ESM (`dist/index.js`), CJS (`dist/index.cjs`), and
type declarations (`dist/index.d.ts`).

## 4. Configure the app

The scaffold reads its configuration from `.env.local`. Copy the documented
template and edit the values for your setup:

```bash
cp scaffold/launch/.env.example scaffold/launch/.env.local
```

The variables are validated at boot by `src/lib/env.ts` (zod), so a missing
required value fails fast with a clear message instead of a cryptic runtime
error. The essentials:

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | client | Backend clouds API base URL. The browser opens the SSE feed (`EventSource`) against this directly, so it must be reachable from the client. |
| `API_URL` | server | Backend clouds API base for the same-origin `/api/*` proxy routes and server components. May point at an internal address. Falls back to `NEXT_PUBLIC_API_URL` if unset. |
| `NEXT_PUBLIC_PONK_CLOUDS_RPC` | client | Solana RPC the wallet/SDK use to build and send transactions. Default `https://api.mainnet-beta.solana.com`. |
| `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` | client | Program id override. Defaults to the real deployed program `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`. Set only for a local/devnet redeploy. |
| `TOKEN_STORAGE_DRIVER` | server | Where uploaded token logos go: `local` (default, writes under `public/uploads`, no external account) or `s3` (S3 / Cloudflare R2). |
| `STORAGE_S3_*`, `STORAGE_PUBLIC_BASE_URL` | server | S3 / R2 bucket, region, endpoint, credentials, and public URL prefix. Required only when `TOKEN_STORAGE_DRIVER=s3`. |

The clone-and-run default (`TOKEN_STORAGE_DRIVER=local`) needs no external
account: token-metadata uploads are written under
`scaffold/launch/public/uploads` and served same-origin.

See [`scaffold/launch/.env.example`](../scaffold/launch/.env.example) for the
full, commented list including every S3 / R2 field.

## 5. Run the dev server

```bash
pnpm --filter @ponkrain/launch run dev
```

The app starts on **`http://localhost:3100`**. Open it and you land on the
explore / home page. Connect a Phantom, Solflare, or Backpack wallet from the
header to launch a market, swap, or provide liquidity.

Equivalently, from inside the app directory:

```bash
cd scaffold/launch
pnpm dev
```

> If `NEXT_PUBLIC_API_URL` does not point at a live clouds indexer, the UI still
> renders, but list and chart data show `--` (honest empty state) rather than
> fabricated numbers. Wallet-side actions (launch, swap, liquidity) work as long
> as `NEXT_PUBLIC_PONK_CLOUDS_RPC` is a reachable RPC with the program deployed.

## 6. Build for production

Produce optimized builds for both members. From the repo root:

```bash
pnpm --filter @ponkrain/sdk run build      # if not already built in step 3
pnpm --filter @ponkrain/launch run build
```

Or build everything in dependency order with the root script:

```bash
pnpm run build
```

`pnpm run build` builds the workspace packages first
(`pnpm -r --filter "./packages/*" run build`) and then the scaffold
(`pnpm -r --filter "./scaffold/*" run build`), so the SDK is always built before
the app that consumes it.

The scaffold's `next.config.mjs` sets `output: "standalone"` with
`outputFileTracingRoot` pointed at the repo root, so the workspace SDK is traced
into a self-contained server bundle under
`scaffold/launch/.next/standalone`. Serve the production build with:

```bash
pnpm --filter @ponkrain/launch run start    # http://localhost:3100 (PORT overrides)
```

For full deployment instructions (copying the standalone bundle, static assets,
and `public/`), see [`scaffold/launch/README.md`](../scaffold/launch/README.md).

## Pointing at a local validator

Until the program is audited, the recommended setup is a local validator with
Ponk Clouds deployed. After deploying the program locally and starting your
clouds indexer against it, set these in `scaffold/launch/.env.local`:

```bash
NEXT_PUBLIC_PONK_CLOUDS_RPC=http://127.0.0.1:8899
NEXT_PUBLIC_PONK_CLOUDS_PROGRAM=<your locally deployed program id>
NEXT_PUBLIC_API_URL=http://127.0.0.1:<your indexer port>
API_URL=http://127.0.0.1:<your indexer port>
```

Then restart `pnpm dev`. The SDK derives every PDA and account offset from the
program id, so a redeployed local program id flows through cleanly.

## Useful workspace scripts

Run these from the repo root. The `-r` flag runs across every workspace member.

| Command | What it does |
| --- | --- |
| `pnpm install` | Install all dependencies and link the workspace SDK. |
| `pnpm run build` | Build the SDK, then the scaffold, in order. |
| `pnpm run dev` | Run every member's `dev` script in parallel (SDK watch build + app dev server). |
| `pnpm run typecheck` | `tsc --noEmit` across the workspace. |
| `pnpm run lint` | Lint across the workspace. |
| `pnpm run clean` | Remove build artifacts (`dist`, `.next`, `out`, `*.tsbuildinfo`). |
| `pnpm --filter @ponkrain/sdk run build` | Build only the SDK. |
| `pnpm --filter @ponkrain/launch run dev` | Run only the app dev server. |

## Troubleshooting

- **`@ponkrain/sdk` cannot be resolved / type errors in the app.** Install from
  the repo root, not from `scaffold/launch`, and run the SDK build
  (`pnpm --filter @ponkrain/sdk run build`) before `next build`.
- **`pnpm` not found or the wrong version.** Run `corepack enable` at the repo
  root; Corepack provisions the pinned pnpm from `package.json`.
- **Env validation throws at boot.** `src/lib/env.ts` lists the offending
  variable. Cross-check it against `scaffold/launch/.env.example` and make sure
  you copied to `.env.local` (not `.env`).
- **Port 3100 is in use.** The dev/start scripts pin port 3100. Stop the other
  process or set `PORT` for `pnpm start`.

## Next steps

- SDK usage and the full `RainClient` API: [`packages/sdk/README.md`](../packages/sdk/README.md).
- App pages, configuration, and deploy: [`scaffold/launch/README.md`](../scaffold/launch/README.md).
