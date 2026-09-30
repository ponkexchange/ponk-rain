# @ponkrain/launch

A clone-and-run **launchpad and market UI** for [Ponk Clouds](https://ponk.exchange),
a bin-based DLMM AMM on Solana with **zero protocol fee at the AMM level**.

This scaffold is the reference frontend for the Ponk Rain kit. It is built
entirely on [`@ponkrain/sdk`](../../packages/sdk) and OUR backend clouds API,
so you can fork it, point it at your own RPC and indexer, and ship a market in
minutes. Everything here is real: no mocked data, no "coming soon" controls.
Where an indexed value is genuinely unknown, the UI renders `--` rather than
inventing a number.

> ponk.exchange was assessed by zauth (Vector) on 29 September 2026: a deep scan
> across 51 endpoints, 5 subdomains and 58 input vectors, every finding verified
> by browser-based proof of concept. 12 findings, no critical. The report is
> published in full at https://ponk.exchange/docs/audits
>
> Test against a local validator or devnet before you deploy capital, as you
> would with any on-chain program.

## What it does

- **Explore** (`/`, `/explore`) - browse and sort live Ponk Clouds pools with a
  platform stat bar (TVL, 24h volume, fees, swaps, traders).
- **Launch** (`/launch`) - create a Ponk Clouds DLMM: pick the token pair, bin
  step, base fee tier, creator protocol fee, and initial price; the app builds,
  signs, and sends `initialize_pool` (plus vault ATAs) and the best-effort
  `init_pool_treasury` follow-up.
- **Trade** (`/trade/[pool]`) - swap against a pool with a live price chart,
  recent-trades tape, and a streaming SSE feed.
- **Pool detail** (`/pool/[address]`) - bin-distribution chart, analytics, and
  add/remove-liquidity panels.
- **Portfolio** (`/portfolio`) - connected-wallet position value, PnL, and
  win rate, with an honest "building history" state for brand-new wallets.

## Tech

Next.js 14 (App Router) - React 18 - TypeScript (strict, ESM) -
`@solana/web3.js` + wallet-adapter (Phantom / Solflare / Backpack) - TanStack
Query - lightweight-charts - Tailwind CSS v3.

## Prerequisites

- **Node >= 20** (`.nvmrc` at the repo root pins 20)
- **pnpm 9** (`corepack enable` will provide it)
- A **Ponk Clouds RPC** endpoint (local validator, devnet, or mainnet)
- A reachable **clouds API** (the indexer that serves `/clouds/*`)

## Quick start (clone and run)

This app lives inside the `ponk-rain` pnpm workspace. Install from the repo
root so the workspace `@ponkrain/sdk` link resolves:

```bash
# from the ponk-rain repo root
corepack enable
pnpm install

# build the SDK once (the app transpiles its source in dev, but a built
# SDK is required for `next build`)
pnpm --filter @ponkrain/sdk run build
```

Then configure and run the app:

```bash
cd scaffold/launch
cp .env.example .env.local      # edit the values for your setup
pnpm dev                        # http://localhost:3100
```

The clone-and-run default uses `TOKEN_STORAGE_DRIVER=local`, which writes
uploaded token logos under `public/uploads` - no external account needed.

## Configuration

All variables are documented in [`.env.example`](./.env.example) and validated
at boot by `src/lib/env.ts`. The essentials:

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | client | Backend clouds API base; the browser opens the SSE feed against it directly. |
| `API_URL` | server | Backend clouds API base for the `/api/*` proxy routes and server components. Falls back to `NEXT_PUBLIC_API_URL`. |
| `NEXT_PUBLIC_PONK_CLOUDS_RPC` | client | Solana RPC for wallet/SDK transaction building. Default `https://api.mainnet-beta.solana.com`. |
| `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` | client | Program id override. Defaults to the real deployed program. |
| `TOKEN_STORAGE_DRIVER` | server | `local` (default) or `s3` for token-metadata uploads. |
| `STORAGE_S3_*`, `STORAGE_PUBLIC_BASE_URL` | server | S3 / R2 credentials and public URL prefix, required when the driver is `s3`. |

### Pointing at a local validator

Set `NEXT_PUBLIC_PONK_CLOUDS_RPC=http://127.0.0.1:8899` and
`NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` to your locally deployed program id, then run
your clouds indexer and set `NEXT_PUBLIC_API_URL` / `API_URL` to it.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3100. |
| `pnpm build` | Production build (`output: "standalone"`). |
| `pnpm start` | Serve the production build on port 3100. |
| `pnpm lint` | `next lint`. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm clean` | Remove `.next` / `out` build artifacts. |

You can also drive everything from the repo root:
`pnpm -r build`, `pnpm -r typecheck`.

## Deploy

`next.config.mjs` sets `output: "standalone"` with `outputFileTracingRoot`
pointed at the `ponk-rain` repo root, so the workspace SDK is traced into a
self-contained server bundle.

```bash
# from the repo root
pnpm install
pnpm --filter @ponkrain/sdk run build
pnpm --filter @ponkrain/launch run build
```

The build emits `scaffold/launch/.next/standalone`. Copy that directory along
with `scaffold/launch/.next/static` (into `.next/static`) and
`scaffold/launch/public` to your server, set the environment variables, and
run:

```bash
node scaffold/launch/.next/standalone/scaffold/launch/server.js
```

The app listens on port 3100 by default (`PORT` overrides). Put it behind your
reverse proxy / TLS terminator. For production token uploads, switch
`TOKEN_STORAGE_DRIVER` to `s3` so logos are not written to the
ephemeral container filesystem.

> No GitHub workflows ship with this scaffold. Deploy from your own
> infrastructure.

## Project layout

```
scaffold/launch/
  src/
    app/            # App Router pages + /api proxy and upload routes
    components/     # UI: wallet, layout, launch, swap, charts, pools, portfolio
    lib/            # sdk wrapper, api client, SSE feed, env, config, storage
  public/           # static assets + uploads (local storage driver)
  .env.example      # documented environment template
```

## License

Apache-2.0. See [`LICENSE`](../../LICENSE) at the repo root.
