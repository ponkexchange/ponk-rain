# Ponk Rain documentation

This directory holds the documentation for **Ponk Rain**, the launch kit and
SDK for [Ponk Clouds](https://ponk.exchange), PONK's bin-based DLMM AMM on
Solana with **zero protocol fee at the AMM level**.

Start at [`index.md`](./index.md) for the full introduction: what Ponk Rain is,
how the monorepo is laid out, and who it is for.

## Contents

- [`index.md`](./index.md) - introduction, monorepo layout, audience, and the
  honesty and safety guarantees that govern the whole project.
- [`quickstart.md`](./quickstart.md) - clone, install, configure, and run the
  monorepo from zero to a launchpad UI on `http://localhost:3100`.
- [`scaffold-guide.md`](./scaffold-guide.md) - fork and customize the
  `@ponkrain/launch` scaffold: structure, pages, branding, wallet config, and
  the pluggable token-metadata storage adapters.

## At a glance

Ponk Rain is a TypeScript monorepo that wraps the deployed Ponk Clouds program
(`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`) so anyone can launch a
concentrated-liquidity market, provide liquidity, trade, and read pool state
without re-deriving the on-chain layout by hand. It ships two pieces:

- `@ponkrain/sdk` - the env-agnostic TypeScript SDK (`packages/sdk`): PDA
  derivation, account decoders, exact off-chain swap and liquidity math, and
  raw `@solana/web3.js` transaction builders. Reads the per-package
  documentation in [`../packages/sdk/README.md`](../packages/sdk/README.md).
- `@ponkrain/launch` - the clone-and-run Next.js launchpad and market UI
  (`scaffold/launch`), built entirely on `@ponkrain/sdk`. Reads the
  per-app documentation in [`../scaffold/launch/README.md`](../scaffold/launch/README.md).

> **UNAUDITED.** The Ponk Clouds program has not passed an external security
> audit. Point it at a local validator or devnet until that changes, and do not
> deposit funds you are not prepared to lose.
