# Deploying Ponk Rain

This guide covers deploying the `@ponkrain/launch` scaffold (the Next.js
launchpad and market UI) to production: the supported targets (self-host,
Vercel, Cloudflare), RPC and indexer choices, the full environment-variable
reference, a token-storage decision, and a mainnet go-live checklist.

The `@ponkrain/sdk` package is a library, not a service: you deploy it only by
publishing it to a registry or consuming it through the workspace. This guide is
about the app. For the SDK, see
[`../packages/sdk/README.md`](../packages/sdk/README.md).

> **UNAUDITED.** The Ponk Clouds program
> (`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`) has not passed an external
> security audit. Until it has, deploy the app against a local validator or
> devnet, or run a mainnet instance only with the explicit, repeated disclaimer
> that it holds funds in unaudited code. Do not deposit funds you are not
> prepared to lose. The mainnet checklist below treats the audit as a gate, not
> an afterthought.

> **No GitHub workflows ship with this kit.** Deploy from your own
> infrastructure. There is no `.github/` directory and none should be added.

---

## What you are deploying

A single Next.js 14 (App Router) app, `scaffold/launch`, living inside the
`ponk-rain` pnpm workspace. It is configured for self-contained output:

- `next.config.mjs` sets `output: "standalone"` with `outputFileTracingRoot`
  pointed at the `ponk-rain` repo root, so the workspace `@ponkrain/sdk` is
  traced into the standalone server bundle. The bundle runs without `node_modules`
  present at the deploy target.
- `transpilePackages: ["@ponkrain/sdk"]` lets the app consume the SDK source in
  dev and bundles it into the build.
- The app listens on **port 3100** by default; `PORT` overrides it.

The app has two runtime dependencies on external services:

1. A **Solana RPC** endpoint (`NEXT_PUBLIC_PONK_CLOUDS_RPC`) the wallet and SDK
   use to build and send pool-create, swap, and liquidity transactions. This is
   used directly from the browser.
2. A **clouds indexer API** (`NEXT_PUBLIC_API_URL` / `API_URL`) that serves the
   `/clouds/*` reads (pools, swaps, stats, fees, volume, portfolio) and the
   `/clouds/feed` SSE stream. The browser opens the EventSource against
   `NEXT_PUBLIC_API_URL`; the server-side `/api/*` proxy routes read from
   `API_URL`.

Neither service ships with this scaffold. You point the app at your own.

---

## Prerequisites

- **Node >= 20** (`.nvmrc` at the repo root pins 20).
- **pnpm 9** (`corepack enable` provisions the pinned version from the root
  `package.json`, `packageManager: pnpm@9.7.0`).
- A reachable **Solana RPC** for your target cluster.
- A reachable **clouds indexer** serving `/clouds/*`.

---

## Build

Always install and build from the **repo root** so the workspace
`@ponkrain/sdk` link resolves, and build the SDK before the app (the app
transpiles SDK source in dev, but `next build` needs the built SDK).

```bash
# from the ponk-rain repo root
corepack enable
pnpm install
pnpm --filter @ponkrain/sdk run build
pnpm --filter @ponkrain/launch run build
```

This emits `scaffold/launch/.next/standalone` (the self-contained server) plus
`scaffold/launch/.next/static` (static assets the server does not copy itself).

You can also run the whole pipeline in dependency order from the root:

```bash
pnpm run build   # builds packages/* then scaffold/* in order
```

---

## Target 1: self-host (standalone, the primary path)

This is the first-class deployment for this kit (it matches the user running
their own server, no third-party PaaS required).

### 1a. Bare VM or any Node host

After `pnpm run build`, the standalone server lives under
`scaffold/launch/.next/standalone/scaffold/launch/server.js`. The standalone
output preserves the workspace path layout, so copy these three things to your
server, keeping the relative structure:

- `scaffold/launch/.next/standalone/` (the server + traced `node_modules`)
- `scaffold/launch/.next/static/` into `scaffold/launch/.next/standalone/scaffold/launch/.next/static/`
- `scaffold/launch/public/` into `scaffold/launch/.next/standalone/scaffold/launch/public/`

A copy step that produces a self-contained directory you can rsync:

```bash
# from the repo root, assemble a deployable tree under ./deploy
rm -rf deploy
mkdir -p deploy
cp -r scaffold/launch/.next/standalone/. deploy/
cp -r scaffold/launch/.next/static deploy/scaffold/launch/.next/static
cp -r scaffold/launch/public deploy/scaffold/launch/public
```

Then on the server, set the environment variables (see the reference below) and
start the server:

```bash
PORT=3100 node scaffold/launch/.next/standalone/scaffold/launch/server.js
```

Put it behind your reverse proxy (nginx, Caddy) for TLS. The proxy must also
forward the `/api/*` routes and not buffer the SSE stream if you proxy the feed
through this origin (the default is the browser opening
`NEXT_PUBLIC_API_URL/clouds/feed` directly, so the app server is not in the SSE
path unless you choose to make it).

Run it under a process supervisor (systemd, pm2) so it restarts on crash. A
minimal systemd unit:

```ini
[Unit]
Description=ponk-rain launch
After=network.target

[Service]
WorkingDirectory=/opt/ponk-rain
Environment=PORT=3100
EnvironmentFile=/opt/ponk-rain/.env
ExecStart=/usr/bin/node scaffold/launch/.next/standalone/scaffold/launch/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile` reads `KEY=value` lines; put the production values there (the
same keys documented below). The `NEXT_PUBLIC_*` values are baked into the
client bundle at **build time**, so set them before `pnpm build`, not just at
runtime. The non-public values (`API_URL`, `TOKEN_STORAGE_DRIVER`,
`STORAGE_S3_*`) are read at runtime by the Node server and so can live in the
`EnvironmentFile`.

### 1b. Docker

There is no Dockerfile in the scaffold by design (deploy from your own infra),
but the standalone output makes one trivial. A multi-stage build:

```dockerfile
# Build stage
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
# Public env must be present at build time (baked into the client bundle).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PONK_CLOUDS_RPC
ARG NEXT_PUBLIC_PONK_CLOUDS_PROGRAM
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_PONK_CLOUDS_RPC=$NEXT_PUBLIC_PONK_CLOUDS_RPC \
    NEXT_PUBLIC_PONK_CLOUDS_PROGRAM=$NEXT_PUBLIC_PONK_CLOUDS_PROGRAM
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ponkrain/sdk run build \
 && pnpm --filter @ponkrain/launch run build

# Runtime stage
FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3100
COPY --from=build /app/scaffold/launch/.next/standalone ./
COPY --from=build /app/scaffold/launch/.next/static ./scaffold/launch/.next/static
COPY --from=build /app/scaffold/launch/public ./scaffold/launch/public
EXPOSE 3100
CMD ["node", "scaffold/launch/.next/standalone/scaffold/launch/server.js"]
```

Build and run, passing the public vars at build time and the server vars at
runtime:

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.ponk.exchange \
  --build-arg NEXT_PUBLIC_PONK_CLOUDS_RPC=https://your-rpc.example \
  --build-arg NEXT_PUBLIC_PONK_CLOUDS_PROGRAM=DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M \
  -t ponk-rain-launch .

docker run -p 3100:3100 \
  -e API_URL=http://clouds-api:8080 \
  -e TOKEN_STORAGE_DRIVER=s3 \
  -e STORAGE_S3_BUCKET=ponk-rain-tokens \
  -e STORAGE_S3_REGION=auto \
  -e STORAGE_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
  -e STORAGE_S3_ACCESS_KEY_ID=... \
  -e STORAGE_S3_SECRET_ACCESS_KEY=... \
  -e STORAGE_PUBLIC_BASE_URL=https://cdn.ponk.exchange/tokens \
  ponk-rain-launch
```

> In a container, the **local** storage driver writes to the ephemeral
> container filesystem and uploads are lost on restart. For Docker / any
> stateless deploy, set `TOKEN_STORAGE_DRIVER=s3` so token logos persist. See
> [Token-metadata storage](#token-metadata-storage) below.

---

## Target 2: Vercel

Vercel detects Next.js and uses its own output adapter, so you do **not** need
the standalone artifacts there. Two settings matter for a pnpm monorepo:

- **Root Directory:** `scaffold/launch`.
- **Build & install:** let Vercel run the install at the repo root so the
  workspace link resolves, but ensure the SDK is built first. Set the
  **Install Command** to `corepack enable && pnpm install` and the **Build
  Command** to:

  ```bash
  pnpm --filter @ponkrain/sdk run build && pnpm --filter @ponkrain/launch run build
  ```

  (Vercel runs these from the repo root when "Include source files outside the
  Root Directory" / monorepo support is on; if you keep the Root Directory at
  `scaffold/launch`, prefix with a `cd ../..` equivalent by using the
  repo-root-relative filters above, which already resolve across the workspace.)

- **Environment variables:** add every variable from the
  [reference](#environment-variable-reference) in the Vercel project settings.
  `NEXT_PUBLIC_*` vars are exposed to the browser; the rest are server-only.
  Vercel injects them at build and runtime, so the public vars are baked
  correctly without extra work.

Caveats on Vercel:

- The **local** storage driver does not work (read-only / ephemeral serverless
  filesystem). You **must** use `TOKEN_STORAGE_DRIVER=s3` on Vercel.
- The `/api/*` proxy and `/api/token/metadata` routes run as serverless
  functions. They are short-lived; the SSE feed is opened by the browser
  directly against `NEXT_PUBLIC_API_URL`, not proxied through the app, so it is
  not subject to function timeouts.

---

## Target 3: Cloudflare

Two viable shapes:

- **Cloudflare Pages (`@cloudflare/next-on-pages`):** runs the app on the Pages
  Functions (Workers) runtime. This is an edge runtime, so the `local` storage
  driver is unavailable and Node-only APIs in any custom route must be
  edge-compatible. Use `TOKEN_STORAGE_DRIVER=s3` and point it at R2 (the S3
  driver is R2-compatible: set `STORAGE_S3_ENDPOINT` to your R2 endpoint and
  `STORAGE_S3_REGION=auto`). Build with `npx @cloudflare/next-on-pages` after
  the standard SDK + app build, and set env vars in the Pages project (public
  vars at build, server vars as Pages secrets).
- **Cloudflare in front of a self-hosted origin:** run the standalone server
  (Target 1) on your own VM and put Cloudflare in front purely as CDN/TLS/WAF.
  This is the simplest path and avoids edge-runtime constraints entirely;
  R2 is still the natural storage backend via the S3 driver.

For either, R2 is the recommended object store for token metadata because the
existing S3 driver speaks the R2 API unchanged.

---

## RPC choices

`NEXT_PUBLIC_PONK_CLOUDS_RPC` is used from the browser to build and send
transactions, so it must be CORS-reachable from the client and able to serve
`getProgramAccounts` (pool discovery) and `getMultipleAccounts` (bin arrays,
decimals) at the rate your traffic needs.

| Cluster | RPC value | When |
| --- | --- | --- |
| Local validator | `http://127.0.0.1:8899` | Local development against a locally deployed program. Set `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` to your local program id. |
| Devnet | a devnet RPC URL | Shared testing before mainnet. The default program id is mainnet; redeploy to devnet and override the program id. |
| Mainnet | a dedicated provider URL | Production. Do **not** use `https://api.mainnet-beta.solana.com` for a real audience. |

Provider notes for mainnet:

- The public `https://api.mainnet-beta.solana.com` is the documented default but
  is rate-limited and **not** suitable for production traffic. It will throttle
  `getProgramAccounts` (pool discovery) hard.
- Use a dedicated provider (the user's existing Helius project is the natural
  choice here; see the user's Helius credentials in memory). Any provider that
  supports `getProgramAccounts` works; the SDK's `discoverPools` returns `[]` on
  RPC failure rather than fabricating, so a throttled endpoint degrades to an
  empty list, not wrong data.
- Because `NEXT_PUBLIC_PONK_CLOUDS_RPC` is public (baked into the client
  bundle), an API key embedded in it is visible to anyone. Prefer a provider
  that supports domain-allowlisting / referrer restrictions for the browser-side
  key, and keep any higher-privilege key server-side.

---

## Environment variable reference

All variables are documented in
[`../scaffold/launch/.env.example`](../scaffold/launch/.env.example) and
validated at boot by `scaffold/launch/src/lib/env.ts` (zod). A missing required
variable fails the build/boot fast with a clear message naming the variable,
rather than failing cryptically at runtime.

`NEXT_PUBLIC_*` variables are inlined into the **client bundle at build time** -
set them before `pnpm build`, and rebuild to change them. The rest are read by
the Node server at runtime.

| Variable | Scope | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | client (build-time) | yes | `https://api.ponk.exchange` | Backend clouds API base. The browser opens the SSE feed (`/clouds/feed`) and read endpoints against it directly. |
| `API_URL` | server | no | falls back to `NEXT_PUBLIC_API_URL` | Backend clouds API base for the same-origin `/api/*` proxy routes and server components. May be an internal address (e.g. `http://clouds-api:8080`) not exposed publicly. |
| `NEXT_PUBLIC_PONK_CLOUDS_RPC` | client (build-time) | yes | `https://api.mainnet-beta.solana.com` | Solana RPC for wallet/SDK transaction building. Local validator, devnet, or a dedicated mainnet provider. |
| `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` | client (build-time) | no | `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M` (in `lib/config.ts`) | Program id override. Set only for a local/devnet redeploy. |
| `TOKEN_STORAGE_DRIVER` | server | no | `local` | Token-metadata storage backend: `local` or `s3`. |
| `STORAGE_S3_BUCKET` | server | when driver `s3` | - | S3 / R2 bucket name. |
| `STORAGE_S3_REGION` | server | when driver `s3` | - | S3 / R2 region (`auto` for R2). |
| `STORAGE_S3_ENDPOINT` | server | when driver `s3` | - | S3-compatible endpoint (e.g. the R2 endpoint URL). |
| `STORAGE_S3_ACCESS_KEY_ID` | server (secret) | when driver `s3` | - | S3 / R2 access key id. |
| `STORAGE_S3_SECRET_ACCESS_KEY` | server (secret) | when driver `s3` | - | S3 / R2 secret access key. |
| `STORAGE_PUBLIC_BASE_URL` | server | when driver `s3` | - | Public base URL prefix (CDN / bucket public URL) used to build the returned image/uri. |
| `PORT` | server (runtime) | no | `3100` | Port the standalone server listens on. |

A minimal mainnet `.env` for a self-hosted deploy with S3/R2 storage:

```bash
NEXT_PUBLIC_API_URL=https://api.ponk.exchange
API_URL=http://clouds-api:8080
NEXT_PUBLIC_PONK_CLOUDS_RPC=https://your-dedicated-rpc.example
NEXT_PUBLIC_PONK_CLOUDS_PROGRAM=DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M
TOKEN_STORAGE_DRIVER=s3
STORAGE_S3_BUCKET=ponk-rain-tokens
STORAGE_S3_REGION=auto
STORAGE_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
STORAGE_S3_ACCESS_KEY_ID=...
STORAGE_S3_SECRET_ACCESS_KEY=...
STORAGE_PUBLIC_BASE_URL=https://cdn.ponk.exchange/tokens
PORT=3100
```

---

## Token-metadata storage

`POST /api/token/metadata` persists creator-uploaded token logos/metadata via a
pluggable `StorageDriver` selected by `TOKEN_STORAGE_DRIVER`:

- **`local`** (default): writes under `scaffold/launch/public/uploads` and
  returns a same-origin `/uploads/<key>` URI. Real and working with **no
  external account**, which is why it is the clone-and-run default. It only
  survives if that directory is on durable, writable storage attached to the
  running process. It does **not** survive on Vercel (read-only/ephemeral),
  Cloudflare (edge), or a fresh container on restart.
- **`s3`**: S3 / R2-compatible. The recommended production driver. Set the
  `STORAGE_S3_*` vars and `STORAGE_PUBLIC_BASE_URL`. R2 works unchanged
  (`STORAGE_S3_REGION=auto`, the R2 endpoint).

Storage matters only for the launch flow's optional logo upload. If a creator
skips the upload, the symbol falls back to the on-chain short-mint, so the app
is fully functional without any storage configured (the `local` default is
enough for development). For any non-local production target, configure `s3`.

---

## Mainnet checklist

Treat the audit as a hard gate. The program is unaudited; a mainnet launch with
real funds is a deliberate risk, not a default.

**Program / on-chain**

- [ ] The Ponk Clouds program is **deployed and verified** at
  `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M` on the target cluster, and
  `NEXT_PUBLIC_PONK_CLOUDS_PROGRAM` matches it (the default is correct for
  mainnet; only override for a redeploy).
- [ ] **External security audit complete** (or the launch is explicitly,
  prominently disclaimed as running unaudited code that holds funds). The
  footer disclaimer in the app states the program is unaudited and the AMM-level
  protocol fee is zero; keep it visible.
- [ ] The platform treasury wallet that receives the default 1% treasury cut is
  the intended PONK treasury address (the user's treasury wallet in memory), and
  `init_pool_treasury` is being sent for created pools.

**Infrastructure**

- [ ] `NEXT_PUBLIC_PONK_CLOUDS_RPC` points at a **dedicated** mainnet RPC
  provider (not the public endpoint), CORS-reachable from the browser, with
  enough `getProgramAccounts` headroom for pool discovery.
- [ ] The clouds indexer at `NEXT_PUBLIC_API_URL` / `API_URL` is up, serving all
  `/clouds/*` endpoints and the `/clouds/feed` SSE stream, on the mainnet
  cluster's data.
- [ ] `TOKEN_STORAGE_DRIVER` is `s3` on any stateless/serverless target;
  `local` is dev-only.
- [ ] All `NEXT_PUBLIC_*` vars are set **before** the build (they bake into the
  client bundle) and the app was rebuilt after any change.
- [ ] TLS terminates in front of the app; the standalone server runs under a
  supervisor (systemd / pm2 / container orchestrator) with restart-on-crash.

**Verification (post-deploy smoke)**

- [ ] `pnpm --filter @ponkrain/launch run typecheck` passes in CI/build.
- [ ] Home (`/`) loads, the stat bar renders real numbers or honest `--`, and
  `/explore` lists pools (or an honest empty state if the indexer has none).
- [ ] Wallet connects (Phantom / Solflare / Backpack) and the connected pubkey
  shows in the header.
- [ ] A test pool create on the target cluster succeeds: `/launch` builds, signs,
  and confirms `initialize_pool` + vault ATAs, then the best-effort
  `init_pool_treasury`, and redirects to `/pool/[address]?action=add`.
- [ ] A small swap on `/trade/[pool]` produces a quote whose `minOut` honors the
  slippage setting, signs, and confirms (the SDK polls signature status, so a
  dropped WebSocket confirmation does not strand the UI).
- [ ] Add and remove liquidity on `/pool/[address]` round-trips a position.
- [ ] If logo upload is enabled, `POST /api/token/metadata` returns a public URI
  that actually resolves on the configured storage backend.

**Security / operational**

- [ ] No secrets in `NEXT_PUBLIC_*` (those are public). Higher-privilege RPC or
  storage keys are server-only.
- [ ] The S3/R2 credentials are scoped to the token bucket only.
- [ ] No GitHub workflows or `.github/` directory were added; deploy is from the
  user's own infrastructure.

---

## Troubleshooting

- **Env validation throws at boot.** `src/lib/env.ts` names the offending
  variable. Cross-check against
  [`../scaffold/launch/.env.example`](../scaffold/launch/.env.example) and make
  sure values are present at **build** time for `NEXT_PUBLIC_*`.
- **`@ponkrain/sdk` cannot be resolved during `next build`.** Install from the
  repo root and run `pnpm --filter @ponkrain/sdk run build` before building the
  app.
- **Pools list is empty in production.** Usually a throttled RPC: `discoverPools`
  returns `[]` on RPC failure by design (no fabrication). Move to a dedicated
  provider, or confirm the indexer is serving `/clouds/pools`.
- **Uploaded token logos disappear after a restart.** You are on the `local`
  storage driver on ephemeral storage. Switch `TOKEN_STORAGE_DRIVER` to `s3`.
- **Port already in use.** The server defaults to 3100; set `PORT` to change it.

---

## Where to go next

- Repo introduction and layout: [`index.md`](./index.md).
- Local quick start and workspace scripts: [`quickstart.md`](./quickstart.md).
- App configuration and pages: [`../scaffold/launch/README.md`](../scaffold/launch/README.md).
- SDK reference: [`../packages/sdk/README.md`](../packages/sdk/README.md).
