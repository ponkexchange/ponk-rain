# Contributing to Ponk Rain

Thanks for working on Ponk Rain, the launch kit and SDK for
[Ponk Clouds](https://ponk.exchange), PONK's bin-based DLMM AMM on Solana. This
guide covers how the repo is built, the rules every change follows, and the local
checks to run before you open one.

If you have not run the repo yet, start with the
[quickstart](docs/quickstart.md), then come back here.

> [!NOTE]
> This project is self-hosted. There are no GitHub workflows in the repo and we
> do not push to GitHub. Open changes against the project's own remote and run
> the checks below locally before submitting.

## Ground rules

These are not stylistic preferences. They are what keeps the kit trustworthy, and
a change that breaks them will be sent back.

1. **No fabrication, ever.** On-chain reads return real values or `null`/`0`.
   Empty bins read as zero reserves, never guesses. Where a value is genuinely
   unknown at runtime, render `--`/`null`, do not invent one. No mock data in
   shipped code paths.
2. **No placeholders.** No "coming soon", no disabled-stub controls, no dead
   buttons. Build a feature for real or omit it.
3. **On-chain parity is sacred.** The SDK's PDA seeds, account byte offsets,
   instruction account orders, discriminators, and swap/liquidity math are ported
   verbatim from the program. If you touch any of them, they must still match the
   real source (see [Where the truth lives](#where-the-truth-lives)). A
   divergence here silently corrupts transactions or quotes.
4. **Non-custodial.** SDK mutating methods build and return unsigned
   instructions (or a `Transaction`) and stop there. They never hold, derive, or
   ask for a private key, and never auto-sign.
5. **No em dash character.** Anywhere: code, comments, docs, JSX. Use hyphens or
   commas instead.
6. **Production quality.** Strict TypeScript, ESM, doc comments on exported
   symbols, and no leftover `TODO`s in committed code.

## Repository layout

Ponk Rain is a pnpm workspace (`pnpm-workspace.yaml`) with two members:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/sdk` | `@ponkrain/sdk` | Env-agnostic TypeScript SDK: PDAs, decoders, exact off-chain math, raw `@solana/web3.js` tx builders. Only dependency is `@solana/web3.js`. |
| `scaffold/launch` | `@ponkrain/launch` | Clone-and-run Next.js 14 launchpad and market UI, built on `@ponkrain/sdk`. |

`docs/` holds the project documentation. The SDK source modules are laid out in
the [monorepo map in the README](README.md#monorepo-layout); each file has a
single, narrow responsibility (for example, `pda.ts` only derives addresses,
`codec.ts` only packs/unpacks bytes), and the public surface is re-exported from
`packages/sdk/src/index.ts`.

## Where the truth lives

The SDK is a faithful port of the on-chain program. When you change anything that
must agree with the chain, cross-check it against the source of truth, do not
guess:

- **Program instructions and account layouts** -
  `ponk-clouds/programs/ponk-clouds/src/lib.rs` and `state.rs` (instruction
  account orders, data encodings, the 212-byte `Pool` layout, `BinArray`,
  `Position`, `PoolTreasury`).
- **Pure math** - `ponk-clouds/crates/clouds-math/src/{price,swap,liquidity,router}.rs`.
  The SDK's `math/price.ts`, `math/swap.ts`, and `math/liquidity.ts` mirror these
  bit-for-bit so an off-chain quote equals the on-chain result.
- **Discriminators** are Anchor's `sha256("global:<instruction>")[..8]` (and
  `sha256("account:<Account>")[..8]` for account-type detection). They live in
  `packages/sdk/src/constants.ts`; recompute and verify by name if you add one.

If the program ever changes, update the ported values and the math together, and
re-run the math tests against fresh on-chain results.

## Development workflow

Install once from the **repo root** (never from inside `scaffold/launch`, the
workspace link only resolves from the root):

```bash
corepack enable
pnpm install
```

Iterate with the watch builds and the dev server:

```bash
pnpm run dev
# or just the SDK watch build:
pnpm --filter @ponkrain/sdk run dev
# or just the app:
pnpm --filter @ponkrain/launch run dev   # http://localhost:3100
```

The scaffold transpiles the SDK's TypeScript source directly during dev, so SDK
edits are picked up live. A **built** SDK (`packages/sdk/dist`) is required for a
production `next build`.

## Before you submit

Run the full local check from the repo root. Everything must pass, with no new
warnings:

```bash
pnpm run typecheck                       # tsc --noEmit across the workspace
pnpm run lint                            # lint across the workspace
pnpm --filter @ponkrain/sdk run test     # SDK unit tests (vitest)
pnpm run build                           # SDK first, then the scaffold, in order
```

A change is ready when:

- `typecheck`, `lint`, `test`, and `build` are all green from a clean install.
- Any new exported symbol has a doc comment and is re-exported from
  `packages/sdk/src/index.ts` if it is part of the public SDK surface.
- Any change to PDA seeds, account offsets, instruction orders, discriminators,
  or math is verified against the on-chain source and covered by a test where the
  math is involved.
- No fabricated data, no placeholders, no disabled stubs, and no em dash
  characters were introduced.

## Tests

The SDK ships `vitest` unit tests. The most valuable ones assert **parity**: that
`math/price.ts`, `math/swap.ts`, and `math/liquidity.ts` reproduce the exact
values the program and `clouds-math` produce (including rounding direction, which
always favors the pool). When you change the math or the ported constants, add or
update a test that pins the expected value, and prefer fixtures captured from real
on-chain results over hand-derived numbers.

```bash
pnpm --filter @ponkrain/sdk run test        # one-shot
pnpm --filter @ponkrain/sdk run test:watch  # watch mode
```

## Commit and change hygiene

- Keep changes focused. One concern per change is easier to review and to revert.
- Write clear commit messages that explain the why, not just the what.
- Do not commit build artifacts (`dist`, `.next`, `out`, `*.tsbuildinfo`),
  secrets, or `.env.local`. Use `.env.example` for documented configuration.
- Update the relevant docs in `docs/` (and the package READMEs) when you change
  behavior, the public API, or configuration.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache-2.0](LICENSE) license.
