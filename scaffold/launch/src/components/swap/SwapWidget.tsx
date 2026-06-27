"use client";

/**
 * The trade surface for a single Ponk Clouds pool.
 *
 * This file owns the three cooperating client pieces the `/trade/[pool]` route
 * renders (kept together so the live feed is opened once and shared):
 *
 *   - {@link TradePanel}  - the client boundary the server page mounts. It opens
 *       the live SSE market feed (`useCloudsFeed`) for the pool and lays out the
 *       two-column {@link TradeView}.
 *   - {@link TradeView}   - the two-column layout: the live price + recent trades
 *       on the left, the {@link SwapWidget} on the right.
 *   - {@link SwapWidget}  - the buy/sell form: amount + max, slippage, an exact
 *       off-chain {@link quoteSwap}, then build {@link buildSwapIxs} (wrapping /
 *       unwrapping wSOL when SOL is a leg), sign with the connected wallet, send,
 *       and confirm by polling ({@link confirmSig}).
 *
 * HONESTY: every quoted figure comes from the exact on-chain-faithful math in
 * `@ponkrain/sdk`; an unknown price renders `--`, never a fabricated number. The
 * swap names only the bin arrays the quote actually walked, capped at the
 * on-chain {@link MAX_SWAP_BIN_ARRAYS} limit, so a client-built tx is
 * byte-indistinguishable from the program's expectation.
 *
 * The feed (`PriceChart` / `RecentTrades`) and the swap rate consume the same
 * streamed price tick, so the displayed market price stays live without the
 * server component re-rendering.
 */

import type * as React from "react";
import { useCallback, useMemo, useState } from "react";
import {
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  NATIVE_MINT_STR,
  MAX_SWAP_BIN_ARRAYS,
  buildSwapIxs,
  closeWsolIx,
  confirmSignature,
  createAtaIdempotentIx,
  fetchPool,
  maxSpendableBaseUnits,
  minOutForSlippage,
  packInstructions,
  quoteSwap,
  swapStartBins,
  wrapSolIxs,
  type SwapQuote,
} from "@ponkrain/sdk";

import { useCloudsFeed, type CloudsPriceTick } from "@/lib/feed";
import {
  formatNumber,
  formatUsd,
  shortenAddress,
  toBaseUnits,
  fromBaseUnits,
} from "@/lib/format";

/**
 * The honesty placeholder for an unknown/`null` value. Kept local so this
 * component never fabricates a number; mirrors the `--` the format layer renders
 * for null at the leaf.
 */
const DASH = "--";
function dash(): string {
  return DASH;
}
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PriceChart } from "@/components/chart/PriceChart";
import { RecentTrades } from "@/components/swap/RecentTrades";

// ---------------------------------------------------------------------------
// View-model types for what the trade page consumes from GET /clouds/pool/:addr.
// ---------------------------------------------------------------------------

/**
 * One side of the pair, as returned by the backend's `pool.tokenX`/`tokenY`.
 * `symbol`/`name` may be empty strings when the token is unindexed (the UI
 * falls back to a short mint); `priceUsd` is `null` when unpriced.
 */
export interface TradePoolToken {
  /** The mint address, base58. */
  address: string;
  /** Resolved symbol, or `""` when unindexed. */
  symbol: string;
  /** Resolved name, or `""` when unindexed. */
  name: string;
  /** Token decimals. */
  decimals: number;
  /** USD price, or `null` when unpriced. */
  priceUsd: number | null;
  /** Whether the token is on the verified list. */
  verified: boolean;
}

/**
 * The `pool` object from `GET /clouds/pool/:address` (envelope-unwrapped).
 *
 * `tokenX` is the base side and `tokenY` the quote side, matching the program's
 * mint-X / mint-Y orientation that every PDA seed depends on. Every money figure
 * is `null` when the indexer has not priced it yet (rendered `--`, never faked).
 */
export interface TradePool {
  /** Pool PDA address, base58. */
  address: string;
  /** Display name, e.g. `"SOL/USDC"`. */
  name: string;
  /** Base-token (X) side. */
  tokenX: TradePoolToken;
  /** Quote-token (Y) side. */
  tokenY: TradePoolToken;
  /** Bin step in basis points; part of the pool PDA seed. */
  binStep: number;
  /** Swap fee as a percent of the trade (e.g. 0.04 for 4 bps). */
  baseFeePct: number;
  /** Protocol fee as a percent OF the swap fee. */
  protocolFeePct: number;
  /** The current decimal-adjusted price (quote per base), or `null`. */
  currentPrice: number | null;
  /** The pool's active bin id. */
  activeBinId: number;
  /** Total value locked in USD, or `null`. */
  tvlUsd: number | null;
  /** 24h volume in USD, or `null`. */
  volume24hUsd: number | null;
  /** 24h fees in USD, or `null`. */
  fees24hUsd: number | null;
  /** Fee APR percent, or `null`. */
  apr: number | null;
  /** Whether swaps are paused on-chain. */
  paused: boolean;
}

/** The full `GET /clouds/pool/:address` payload (envelope-unwrapped). */
export interface TradePoolDetail {
  /** The pool object. */
  pool: TradePool;
  /** The bin book window around the active bin. */
  bins: {
    activeBinId: number;
    binStep: number;
    bins: Array<{
      binId: number;
      price: number | null;
      reserveX: number;
      reserveY: number;
      isActive: boolean;
    }>;
  };
  /** 24h pool metrics, or `null` when unindexed. */
  metrics: unknown;
}

// ---------------------------------------------------------------------------
// TradePanel: the client boundary + live feed for the route.
// ---------------------------------------------------------------------------

/**
 * The client wrapper the `/trade/[pool]` server page mounts.
 *
 * Opens the live SSE market feed scoped to this pool and renders the
 * two-column {@link TradeView}. The latest `price` tick is threaded into both
 * the chart/tape and the swap rate so the whole panel stays live off one
 * stream.
 *
 * @param pool - the envelope-unwrapped `GET /clouds/pool/:address` payload.
 */
export function TradePanel({ pool }: { pool: TradePoolDetail }) {
  const address = pool.pool.address;
  // Request the price + ticker feeds for this pool; the hook auto-reconnects
  // and tears down when the address changes. Null priceUsd is forwarded as-is.
  const { lastPrice } = useCloudsFeed({
    pool: address,
    feeds: ["price", "ticker"],
  });

  return <TradeView pool={pool} livePrice={lastPrice} />;
}

// ---------------------------------------------------------------------------
// TradeView: the two-column layout.
// ---------------------------------------------------------------------------

/**
 * The trade layout: price chart + recent trades on the left, the swap widget on
 * the right. Presentational; all live state is passed in.
 *
 * @param pool - the resolved pool detail.
 * @param livePrice - the latest streamed price tick, or `null` before the first.
 */
export function TradeView({
  pool,
  livePrice,
}: {
  pool: TradePoolDetail;
  livePrice: CloudsPriceTick | null;
}) {
  const p = pool.pool;
  const pairLabel = p.name || `${shortLeg(p.tokenX)} / ${shortLeg(p.tokenY)}`;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-fg">{pairLabel}</h1>
            <p className="text-sm text-muted">
              Bin step {p.binStep} bps - fee {formatNumber(p.baseFeePct, 2)}%
              {p.paused ? " - paused" : ""}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-muted">
              Price ({legSymbol(p.tokenY)} per {legSymbol(p.tokenX)})
            </div>
            <div className="font-mono text-lg text-fg">
              {/* Live USD price when streamed, else the indexed pool price; -- when neither. */}
              {livePrice?.priceUsd != null
                ? formatUsd(livePrice.priceUsd)
                : p.currentPrice != null
                  ? formatNumber(p.currentPrice, 6)
                  : dash()}
            </div>
          </div>
        </header>

        {/* PriceChart loads its own OHLCV history scoped to the pool; we hand it
            the pool identity, the pair labels, and the same live/active prices
            this header shows so the chart's last-price line stays in lockstep. */}
        <PriceChart
          pool={p.address}
          symbol={legSymbol(p.tokenX)}
          quoteSymbol={legSymbol(p.tokenY)}
          livePrice={livePrice?.priceUsd ?? null}
          activePrice={p.currentPrice}
        />

        <RecentTrades pool={p.address} />
      </section>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <SwapWidget pool={pool} livePrice={livePrice} />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SwapWidget: the buy/sell form.
// ---------------------------------------------------------------------------

/** Transaction lifecycle phase for the widget's submit button + message. */
type SwapPhase = "idle" | "quoting" | "submitting" | "done" | "error";

/** A resolved leg (one mint of the pair) for input/output fields. */
interface Leg {
  mint: string;
  symbol: string;
  decimals: number;
}

/** Display symbol for a leg, falling back to a short mint when unindexed. */
function legSymbol(t: TradePoolToken): string {
  return t.symbol && t.symbol.length > 0 ? t.symbol : shortenAddress(t.address);
}

/** Short label for a token (used in the pair title fallback). */
function shortLeg(t: TradePoolToken): string {
  return legSymbol(t);
}

/**
 * The buy/sell widget for one Ponk Clouds pool.
 *
 * The user picks a direction (base<->quote), an amount (with a `max` that
 * reserves SOL for the wrap when SOL is the input), and a slippage tolerance.
 * The widget quotes the swap off-chain with the exact `@ponkrain/sdk` math,
 * shows the expected output and a slippage-floored minimum, then on submit
 * builds + signs + sends the swap (wrapping/closing wSOL when SOL is a leg) and
 * confirms by polling the signature status.
 *
 * @param pool - the resolved pool detail (drives the legs + bin step).
 * @param livePrice - the latest streamed price tick, used only for display.
 */
export function SwapWidget({
  pool,
  livePrice,
}: {
  pool: TradePoolDetail;
  livePrice: CloudsPriceTick | null;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  const p = pool.pool;
  const mintX = useMemo(() => new PublicKey(p.tokenX.address), [p.tokenX.address]);
  const mintY = useMemo(() => new PublicKey(p.tokenY.address), [p.tokenY.address]);

  const legX: Leg = {
    mint: p.tokenX.address,
    symbol: legSymbol(p.tokenX),
    decimals: p.tokenX.decimals,
  };
  const legY: Leg = {
    mint: p.tokenY.address,
    symbol: legSymbol(p.tokenY),
    decimals: p.tokenY.decimals,
  };

  // Direction. `xForY === true` sells X (base) for Y (quote): input is the X
  // leg, output is the Y leg. Default to selling the quote for the base
  // ("buy the base"), which is the common entry intent.
  const [xForY, setXForY] = useState<boolean>(false);
  const inputLeg = xForY ? legX : legY;
  const outputLeg = xForY ? legY : legX;

  const [amount, setAmount] = useState<string>("");
  // Slippage tolerance in percent; stored as a string so the field can be empty
  // mid-edit. Defaults to 0.5%.
  const [slippagePct, setSlippagePct] = useState<string>("0.5");

  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [phase, setPhase] = useState<SwapPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  // The connected wallet's spendable balance of the input mint, in base units,
  // or null when not yet read.
  const [inBalance, setInBalance] = useState<bigint | null>(null);

  const amountBase = useMemo(
    () => toBaseUnits(amount, inputLeg.decimals),
    [amount, inputLeg.decimals],
  );

  const slippageBps = useMemo(() => {
    const v = Number(slippagePct);
    if (!Number.isFinite(v) || v < 0) return 0;
    // percent -> bps, clamped to the SDK's accepted [0, 10000] range.
    return Math.min(Math.round(v * 100), 10_000);
  }, [slippagePct]);

  /**
   * Read the input mint's spendable balance for the `max` button. For native
   * SOL we use the lamport balance (the wrap reserve is applied separately);
   * for SPL tokens we sum the owner's token-account balance. Returns null on
   * any failure rather than guessing.
   */
  const loadBalance = useCallback(async (): Promise<bigint | null> => {
    if (!publicKey) return null;
    try {
      if (inputLeg.mint === NATIVE_MINT_STR) {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        return BigInt(lamports);
      }
      const resp = await connection.getParsedTokenAccountsByOwner(publicKey, {
        mint: new PublicKey(inputLeg.mint),
      });
      let total = 0n;
      for (const { account } of resp.value) {
        const raw = account.data.parsed?.info?.tokenAmount?.amount as
          | string
          | undefined;
        if (raw) total += BigInt(raw);
      }
      return total;
    } catch {
      return null;
    }
  }, [connection, publicKey, inputLeg.mint]);

  /** Set the amount field to the spendable max of the input leg. */
  const onMax = useCallback(async () => {
    const bal = await loadBalance();
    setInBalance(bal);
    if (bal == null) return;
    const spendable = maxSpendableBaseUnits(bal, new PublicKey(inputLeg.mint));
    setAmount(fromBaseUnits(spendable, inputLeg.decimals));
  }, [loadBalance, inputLeg.mint, inputLeg.decimals]);

  /** Flip the swap direction and clear the stale quote. */
  const onFlip = useCallback(() => {
    setXForY((d) => !d);
    setQuote(null);
    setAmount("");
    setMessage(null);
    setSig(null);
    setPhase("idle");
    setInBalance(null);
  }, []);

  /**
   * Quote the swap off-chain with the exact on-chain math. Reads the pool and
   * the bin arrays the walk can touch and returns the precise output; an empty
   * or invalid amount clears the quote. Never fabricates an output.
   */
  const onQuote = useCallback(async () => {
    setMessage(null);
    if (amountBase == null || amountBase <= 0n) {
      setQuote(null);
      return;
    }
    setPhase("quoting");
    try {
      const q = await quoteSwap(connection, {
        mintX,
        mintY,
        binStep: p.binStep,
        amountIn: amountBase,
        xForY,
      });
      setQuote(q);
      setPhase("idle");
    } catch (e) {
      setQuote(null);
      setPhase("error");
      setMessage(e instanceof Error ? e.message : "could not quote swap");
    }
  }, [amountBase, connection, mintX, mintY, p.binStep, xForY]);

  /**
   * Build, sign, send, and confirm the swap.
   *
   * Re-quotes against current chain state for an exact `min_out`, then assembles
   * the ordered instruction list: wrap native SOL into wSOL when it is the
   * input, ensure the output token account exists, the swap itself (CU budget +
   * `swap`, naming only the arrays the quote walked), and a wSOL close to sweep
   * any wrapped dust + rent back when SOL is either leg. The whole bundle is
   * packed into a single atomic transaction (it always fits), signed by the
   * wallet, sent, and confirmed by polling the signature status.
   */
  const onSwap = useCallback(async () => {
    if (!publicKey || !signTransaction) {
      setMessage("connect a wallet to swap");
      return;
    }
    if (amountBase == null || amountBase <= 0n) {
      setMessage("enter an amount");
      return;
    }
    if (p.paused) {
      setMessage("this pool is paused");
      return;
    }
    setPhase("submitting");
    setMessage(null);
    setSig(null);
    try {
      // Re-quote against live state so `min_out` reflects the current book, and
      // learn how many arrays the walk touches (capped on-chain).
      const fresh = await quoteSwap(connection, {
        mintX,
        mintY,
        binStep: p.binStep,
        amountIn: amountBase,
        xForY,
      });
      setQuote(fresh);
      if (fresh.amountOut <= 0n) {
        throw new Error("no liquidity to fill this swap");
      }

      const pool = await fetchPool(connection, mintX, mintY, p.binStep);
      if (!pool) throw new Error("Ponk Clouds pool not found at this RPC");

      const minOut = minOutForSlippage(fresh.amountOut, slippageBps);
      const arrayCount = Math.min(
        Math.max(1, fresh.binArraysTouched),
        MAX_SWAP_BIN_ARRAYS,
      );
      const startBins = swapStartBins(pool.activeBinId, arrayCount, xForY);

      const inIsSol = inputLeg.mint === NATIVE_MINT_STR;
      const outIsSol = outputLeg.mint === NATIVE_MINT_STR;

      const pre: TransactionInstruction[] = [];
      // Wrap exactly the SOL being spent into the user's wSOL ATA when SOL is
      // the input; the swap reads the wSOL token account, not native SOL.
      if (inIsSol) {
        pre.push(...wrapSolIxs(publicKey, amountBase));
      } else {
        pre.push(createAtaIdempotentIx(publicKey, publicKey, new PublicKey(inputLeg.mint)));
      }
      // Make sure the output token account exists to receive the proceeds.
      if (outIsSol) {
        pre.push(createAtaIdempotentIx(publicKey, publicKey, new PublicKey(NATIVE_MINT_STR)));
      } else {
        pre.push(createAtaIdempotentIx(publicKey, publicKey, new PublicKey(outputLeg.mint)));
      }

      const swapIxs = buildSwapIxs({
        user: publicKey,
        mintX,
        mintY,
        binStep: p.binStep,
        startBins,
        amountIn: amountBase,
        minOut,
        xForY,
      });

      // Unwrap any wSOL (the swap output, or leftover wrapped input) plus its
      // rent back to the owner when SOL is either leg.
      const post: TransactionInstruction[] =
        inIsSol || outIsSol ? [closeWsolIx(publicKey)] : [];

      const all = [...pre, ...swapIxs, ...post];
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      // Pack the flat list into the fewest legacy transactions that each fit
      // the wire cap (a single swap always fits one), then materialize each
      // group into a signable Transaction with the connected wallet as payer.
      const txs = packInstructions(all, publicKey).map((ixs) => {
        const tx = new Transaction().add(...ixs);
        tx.feePayer = publicKey;
        tx.recentBlockhash = blockhash;
        return tx;
      });

      // A single swap (wrap + ATA + swap + close) always fits one transaction;
      // sign the one tx, or fall back to signAllTransactions defensively.
      const signed =
        txs.length === 1
          ? [await signTransaction(txs[0])]
          : signAllTransactions
            ? await signAllTransactions(txs)
            : null;
      if (!signed) {
        throw new Error("wallet cannot sign this swap");
      }

      let lastSig = "";
      for (const s of signed) {
        lastSig = await connection.sendRawTransaction(s.serialize(), {
          skipPreflight: false,
        });
        // Poll the status directly: WS-based confirmation falsely reports
        // "expired" on RPCs that drop the subscribe notification.
        await confirmSignature(connection, lastSig, { commitment: "confirmed" });
      }
      setSig(lastSig);
      setPhase("done");
      setMessage(
        `Swapped ${formatNumber(Number(amount), 6)} ${inputLeg.symbol} for ${fromBaseUnits(fresh.amountOut, outputLeg.decimals)} ${outputLeg.symbol}.`,
      );
      setAmount("");
      setQuote(null);
      setInBalance(null);
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : "swap failed");
    }
  }, [
    publicKey,
    signTransaction,
    signAllTransactions,
    amountBase,
    amount,
    connection,
    mintX,
    mintY,
    p.binStep,
    p.paused,
    xForY,
    slippageBps,
    inputLeg,
    outputLeg,
  ]);

  // Expected output (human), the slippage-floored minimum, and the effective
  // rate, all from the live quote. Null/`--` when there is no quote yet.
  const expectedOut =
    quote != null ? fromBaseUnits(quote.amountOut, outputLeg.decimals) : null;
  const minReceived =
    quote != null
      ? fromBaseUnits(minOutForSlippage(quote.amountOut, slippageBps), outputLeg.decimals)
      : null;
  const rate =
    quote != null && quote.amountInConsumed > 0n
      ? Number(quote.amountOut) /
        10 ** outputLeg.decimals /
        (Number(quote.amountInConsumed) / 10 ** inputLeg.decimals)
      : null;
  const unfilled = quote != null && quote.amountInRemaining > 0n;

  const submitting = phase === "submitting";
  const quoting = phase === "quoting";
  const canSwap =
    !!publicKey &&
    amountBase != null &&
    amountBase > 0n &&
    !p.paused &&
    !submitting;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Swap</h2>
        <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          zero protocol fee
        </span>
      </div>

      {/* Input leg */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>You pay</span>
          <button
            type="button"
            onClick={onMax}
            disabled={!publicKey}
            className="font-medium text-pink hover:underline disabled:cursor-not-allowed disabled:text-muted"
          >
            Max
            {inBalance != null
              ? ` (${fromBaseUnits(inBalance, inputLeg.decimals)})`
              : ""}
          </button>
        </div>
        <Input
          mono
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setAmount(e.target.value);
            setQuote(null);
          }}
          onBlur={onQuote}
          suffix={inputLeg.symbol}
        />
      </div>

      {/* Direction flip */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onFlip}
          aria-label="Flip swap direction"
          className="rounded-card border border-line bg-elevated px-3 py-1 text-sm text-fg hover:border-pink"
        >
          {inputLeg.symbol} -&gt; {outputLeg.symbol}
        </button>
      </div>

      {/* Output leg (read-only estimate) */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">You receive (estimated)</span>
        <div className="flex items-center justify-between rounded-card border border-line bg-panel px-3 py-2">
          <span className="font-mono text-fg">
            {quoting ? "..." : expectedOut != null ? expectedOut : dash()}
          </span>
          <span className="text-sm text-muted">{outputLeg.symbol}</span>
        </div>
      </div>

      {/* Slippage */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">Slippage tolerance</span>
        <div className="flex items-center gap-1">
          {["0.1", "0.5", "1"].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setSlippagePct(preset)}
              className={`rounded-card border px-2 py-0.5 text-xs ${
                slippagePct === preset
                  ? "border-pink text-pink"
                  : "border-line text-muted hover:border-pink"
              }`}
            >
              {preset}%
            </button>
          ))}
          <Input
            mono
            inputMode="decimal"
            value={slippagePct}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setSlippagePct(e.target.value)
            }
            suffix="%"
            className="w-20"
          />
        </div>
      </div>

      {/* Quote detail */}
      <dl className="flex flex-col gap-1 rounded-card border border-line bg-panel px-3 py-2 text-xs">
        <Row label="Rate">
          {rate != null
            ? `1 ${inputLeg.symbol} = ${formatNumber(rate, 6)} ${outputLeg.symbol}`
            : dash()}
        </Row>
        <Row label="Minimum received">
          {minReceived != null ? `${minReceived} ${outputLeg.symbol}` : dash()}
        </Row>
        <Row label="Bin step">{`${p.binStep} bps`}</Row>
        <Row label="Live price">
          {livePrice?.priceUsd != null ? formatUsd(livePrice.priceUsd) : dash()}
        </Row>
      </dl>

      {unfilled ? (
        <p className="text-xs text-amber">
          Only part of this amount can be filled with the pool&apos;s current
          liquidity; the remainder is returned.
        </p>
      ) : null}

      <Button
        variant="primary"
        onClick={onSwap}
        disabled={!canSwap}
        className="w-full"
      >
        {submitting
          ? "Swapping..."
          : !publicKey
            ? "Connect wallet"
            : p.paused
              ? "Pool paused"
              : `Swap ${inputLeg.symbol} for ${outputLeg.symbol}`}
      </Button>

      {message ? (
        <p
          className={`text-xs ${phase === "error" ? "text-red" : "text-muted"}`}
        >
          {message}
          {sig ? (
            <>
              {" "}
              <a
                href={`https://solscan.io/tx/${sig}`}
                target="_blank"
                rel="noreferrer"
                className="text-pink hover:underline"
              >
                view on Solscan
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </Card>
  );
}

/** A label / value row inside the quote-detail list. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-fg">{children}</dd>
    </div>
  );
}
