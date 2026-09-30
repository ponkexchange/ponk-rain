# Ponk Rain concepts

This document explains the ideas behind Ponk Rain and the on-chain market it
launches. Ponk Rain is the launch-and-trade surface for **Ponk Clouds**, a
bin-based discretized-liquidity AMM (a "DLMM") deployed on Solana at program id
`DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`.

Everything here is a faithful description of the real program in
`ponk-clouds/programs/ponk-clouds` and its pure math crate `clouds-math`. There
is no marketing rounding: the numbers, caps, and rounding directions below are
the exact ones the program enforces.

> The Ponk Clouds program is deployed on Solana mainnet. ponk.exchange was
> assessed by zauth (Vector) on 29 September 2026; the report is published in
> full at https://ponk.exchange/docs/audits
>
> Every figure below is a description of what the program does, taken from its
> source and its math crate.
>
> The ponk.exchange web application, API and MCP server were assessed separately
> by zauth (Vector) on 29 September 2026, published in full at
> [ponk.exchange/docs/audits](https://ponk.exchange/docs/audits). That assessment
> did not read this program.

---

## 1. DLMM bins

A traditional constant-product AMM (`x * y = k`) spreads one LP's liquidity
across every possible price from zero to infinity. Most of that liquidity sits at
prices that never trade, so it earns nothing and adds slippage.

A DLMM ("Discretized Liquidity Market Maker") instead chops the price axis into a
sequence of discrete **bins**. Each bin covers a single, fixed price and holds
its own slice of reserves. Liquidity providers choose which bins to fund, so they
can concentrate capital exactly where trading happens.

Key consequences of the bin model:

- **Constant-sum inside a bin.** Within one bin the price is fixed at that bin's
  `price_q64`, so token X and token Y trade one-for-one at that rate with **zero
  in-bin slippage**. Selling X into a bin draws down that bin's Y reserve at the
  fixed price until the bin's output side is empty.
- **Price moves by crossing bins.** When a bin's output side is exhausted, the
  swap advances to the next bin (which has a different fixed price) and continues
  there. Price discovery is the act of walking from bin to bin. The bin the price
  currently sits in is the pool's `active_bin_id`.
- **A position is a set of bins.** An LP `Position` is a claim on a contiguous
  range `[lower_bin_id, upper_bin_id]`, tracking `shares` per bin. Each bin in a
  position is independent bookkeeping: its own reserves and its own
  `total_shares`.

### Bin storage geometry

Bins are stored in fixed windows called **bin arrays**. Each `BinArray` holds
exactly **70 bins** (`BINS_PER_ARRAY = 70`) and is keyed by the absolute bin id of
its first slot (`start_bin_id`). The window that contains a given bin starts at:

```
arrayStartForBin(binId) = floor(binId / 70) * 70   // negative bin ids handled
```

A single bin slot stores three `u128` values: `reserve_x`, `reserve_y`, and
`total_shares`.

A swap loads the bin arrays it needs as transaction accounts. The program caps a
single swap at **2 bin arrays** (`MAX_SWAP_BIN_ARRAYS = 2`): the named
`bin_array` plus up to one more passed as a remaining account. Two arrays cover
140 contiguous bins.

That cap is a **measured compute-budget limit, not an arbitrary choice**. The
binding cost is the number of bins *walked*, because each crossed bin runs a
fixed-point price exponentiation (~5k compute units per bin). A 3-array walk of
~210 bins measured at roughly 750k CU, nearly 4x past the 200k per-instruction
default, and would simply abort on-chain. The math crate therefore also bounds a
single swap walk at **28 bins** (`MAX_BINS_PER_SWAP = 28`); realistic swaps cross
only a handful of bins, and the cap only bounds the adversarial maximum.

---

## 2. Bin step

The **bin step** is the width of one bin, expressed in basis points (bps; 1 bp =
1/10,000). It is the geometric gap between one bin's price and the next.

Bin prices are a geometric sequence anchored at bin 0 = price 1.0:

```
price(binId) = (1 + binStep / 10_000) ^ binId      // token Y per token X
```

So with a 25 bps bin step (`0.25%`), each bin is `1.0025x` the price of the bin
below it. A smaller bin step means tighter bins, finer price granularity, and
lower slippage near the active price, at the cost of needing more bins (and thus
more arrays / compute) to span a given price range.

The bin step is chosen by the pool creator at launch and is **part of the pool's
identity**: the pool PDA is derived from `[b"pool", mintX, mintY, binStep_u16_LE]`,
so the same token pair can have multiple independent pools at different bin steps.
The launcher presets mirror the Meteora-style chips: `1, 2, 4, 5, 10, 20, 50, 100`
bps. A bin step of 0 is rejected on-chain (`InvalidBinStep`).

### Exact pricing (Q64.64)

For display, the UI uses float math (`priceOfBin` / `binIdForPrice`) that also
folds in token decimals: `price * 10^(decX - decY)` for a human "quote per base"
number.

For anything that must match the chain bit-for-bit (swap quotes), the price is
the exact integer **Q64.64** value `bin_price_q64(binId, binStep)`, where the
integer `2^64` represents the real value `1.0`. It is computed with
integer-only exponentiation-by-squaring so it is deterministic with no floats.
Negative bins are the reciprocal of the positive bin via `floor(2^128 / price)`.
Intermediate multiplies round **down**, so the reported price is a lower bound on
the true price, and the swap math is written so this rounding still favors the
pool.

### Picking the active bin from a price

At launch the creator gives an initial human price; the launcher converts it to
the starting `active_bin_id` with `binIdForPrice(price, binStep, decX, decY)`
(the inverse of `priceOfBin`). It returns `null` for a non-positive or
non-finite price.

---

## 3. Fees

Every swap charges a **swap fee** in bps **of the trade**. The fee is taken off
the **input** first, then the net input is converted to output at the bin price.
Because the fee is removed before conversion, LPs earn on raw volume.

```
fee      = floor(amountIn * swapFeeBps / 10_000)
netIn    = amountIn - fee
amountOut = convert(netIn at bin price)            // floored toward the pool
```

The swap fee is capped at **1000 bps (10%)** on-chain (`MAX_SWAP_FEE_BPS`). That
ceiling exists only to stop an abusive griefing configuration; real fee tiers are
far lower. The launcher base-fee presets are `1, 4, 5, 10, 30, 100` bps.

Output is always **floored** (the pool keeps the dust). When a swap only partially
fills a bin, the required input is computed by rounding the net input **up** and
then grossing the fee back up, so the pool is never undercharged. Rounding always
favors the pool, never the trader.

The whole swap fee is split into at most three shares, in this order:

1. **Protocol fee** -> the pool creator (see section 5).
2. **Treasury fee** -> the Ponk platform wallet (see below).
3. **LP fee** -> everything left over, which stays in the bin's reserves and is
   what makes LP shares appreciate.

Both the protocol and treasury shares are expressed in **bps OF the swap fee**
(not of the trade). They are **jointly clamped** so their sum can never exceed the
whole fee:

```
pf = min(protocolFeeBps, 10_000)
tf = min(treasuryFeeBps, 10_000 - pf)
// protocolFee + treasuryFee <= fee   ALWAYS
// lpFee = fee - protocolFee - treasuryFee   (the residual, always >= 0)
```

The protocol and treasury cuts are **withheld in the input vault and accrued**
separately (`protocol_fee_x/y` on the pool, `treasury_fee_x/y` on the treasury
config). They are not part of any bin's reserves, so LP withdrawals never touch
them, and they are claimed later by their owners.

---

## 4. The zero-protocol-fee model

The defining property of Ponk Clouds is that **at the AMM level the protocol fee
is zero by default**. A pool created with `protocolFeeBps = 0` sends 100% of the
swap fee to its LPs (minus only the small platform treasury cut described next).
The math has an explicit fast path for this: with both platform shares at zero,
the entire fee accrues to the bin's LPs and the behavior is byte-for-byte the
same as a fee-only-to-LP AMM.

This is the inversion versus typical DLMMs: Meteora/Orca-style venues commonly
keep 5-15% of every swap fee as protocol revenue. Ponk Clouds keeps **nothing at
the AMM level by default**, which is the whole point of the design. LP yield is
not skimmed.

There is one small, separate platform cut: the **treasury fee**. It lives in a
distinct per-pool PDA (`[b"pool_treasury", pool]`) so it never touches the live
212-byte `Pool` layout, and it defaults to **100 bps OF the swap fee (1% of the
fee, not 1% of the trade)** going to the Ponk treasury wallet
`7nNPreWHRmKNbr8AUHFRttVw6fPFAQhVT1tfrYZ7685K`. When a pool has no treasury config
at all, the treasury fee is treated as 0 and swaps behave exactly as if it did not
exist.

So the honest framing is: **zero protocol fee at the AMM level; a 1%-of-fee
platform treasury cut by default.** On, say, a 4 bps swap fee, 1% of that fee is
0.0004% of the trade.

Hard caps protect LPs even from a misconfigured authority:

| Cap | Value | Meaning |
| --- | --- | --- |
| `MAX_SWAP_FEE_BPS` | 1000 | swap fee <= 10% of the trade |
| `MAX_PROTOCOL_FEE_BPS` | 5000 | creator cut <= 50% of the fee |
| `MAX_TREASURY_FEE_BPS` | 5000 | platform cut <= 50% of the fee |

Because the protocol cut alone is capped at 50% of the fee, **LPs always keep at
least half the swap fee from the creator's cut**, and the joint clamp guarantees
the LP residual is never negative.

---

## 5. Creator-kept fees

A pool creator may opt to keep a slice of the swap fee for themselves by setting a
non-zero `protocolFeeBps` at launch. This is the "protocol fee" field on-chain,
but economically it is the **creator's revenue**: they own the pool `authority`
and are the only party who can claim it.

- It is a share **of the swap fee**, in bps (`10000 = 100% of the fee`). The
  launcher presets are `0, 1000, 2000, 3000` (0%, 10%, 20%, 30% of the fee).
- It is bounded by `MAX_PROTOCOL_FEE_BPS = 5000` (50% of the fee), so a creator
  can never take the whole fee.
- It accrues per-swap into the pool's `protocol_fee_x` / `protocol_fee_y`
  (input-token base units) and is **claimed by the authority** via
  `claim_protocol_fees` to the authority's own token accounts.

A worked example, mirroring the launcher's own copy: with a 4 bps swap fee and a
20% creator cut, the creator keeps 20% of the fee, Ponk takes its 1%, and LPs keep
the remaining ~79%. The helper `protocolFeePctOfTrade(protocolFeeBps, swapFeeBps)`
expresses the creator's cut as a percentage of the trade
(`protocolFeeBps * swapFeeBps / 1e6`) for display.

The treasury (platform) fee is independent of the creator cut; both are clamped
jointly against the fee, and the LP always receives the residual.

---

## 6. Non-custodial design

Ponk Rain never takes custody of funds or keys.

- **The SDK builds, it does not sign.** Every mutating method on `RainClient`
  (`rain`, `swap`, `addLiquidity`, `removeLiquidity`, `closePosition`,
  `claimProtocolFees`, `claimTreasuryFees`) returns a built
  `TransactionInstruction[]` (and the derived addresses) and stops there. Signing
  is always done by a caller-supplied signer (the user's wallet). The SDK never
  holds a secret key and never auto-signs.
- **Reserves live in program-owned vaults, not ours.** A pool's token reserves
  sit in the pool PDA's associated token accounts (`vault_x` / `vault_y`). Only
  the program can move them, and only via the swap and liquidity instructions
  whose math is fixed in `clouds-math`. There is no admin key that can sweep
  reserves.
- **LP funds are owned by the LP.** A `Position` PDA is derived from the owner's
  pubkey (`[b"position", pool, owner, lower_i32_LE]`). Only the owner can add to,
  remove from, or close their position, and a withdrawal returns a strictly
  proportional, floored-toward-the-pool slice of reserves.
- **Fees are claimed by their rightful owner, by them.** Creator (protocol) fees
  are claimable only by the pool `authority`; treasury fees only to the configured
  treasury wallet's token accounts. Ponk Rain never routes either through an
  intermediary it controls.
- **Slippage is the trader's guarantee.** Every swap carries a `minOut` the
  trader sets; the program reverts if the actual output is below it. The SDK
  computes an honest `minOut` by running the exact `clouds-math` swap off-chain
  (`quoteSwap` + `minOutForSlippage`), so the quote the user sees matches the
  chain.
- **The authority's power is bounded, not custodial.** A pool `authority` can
  pause the pool, change its own protocol-fee bps (within the 50%-of-fee cap), and
  set the treasury destination. It can never seize LP reserves, exceed the fee
  caps, or take more than the residual leaves for LPs.

The seeding floor (`MIN_LIQUIDITY = 1000` shares on a bin's first deposit) and the
surplus-refund deposit accounting exist to keep first-deposit share math safe from
donation/inflation attacks, not to lock funds: 1000 base units is dust at any
realistic token decimals.

---

## Glossary

- **Bin** - one discrete price slot holding `reserve_x`, `reserve_y`, and
  `total_shares`.
- **Bin step** - the geometric width of a bin in bps; `(1 + binStep/1e4)` is the
  ratio between adjacent bin prices.
- **Active bin** - the bin where the current price sits (`active_bin_id`).
- **Bin array** - a fixed 70-bin storage window; a swap loads up to 2.
- **Swap fee** - bps of the trade, taken off the input, split into
  protocol/treasury/LP shares.
- **Protocol fee** - the creator's cut, in bps of the swap fee, claimed by the
  pool authority.
- **Treasury fee** - the Ponk platform's cut (default 1% of the fee), claimed to
  the treasury wallet.
- **LP fee** - the residual fee after the two platform shares; it stays in the bin
  and grows LP shares.
- **Position** - an owner's per-bin share claim over `[lower, upper]`.
- **Q64.64** - fixed-point format where the integer `2^64` represents `1.0`; the
  exact on-chain price representation.
