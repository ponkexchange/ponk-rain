"use client";

/**
 * LaunchForm - the create-a-Ponk-Clouds-DLMM ("Ponk Rain") form.
 *
 * Picks a base + quote mint, a bin-step preset, a base swap-fee tier, the
 * creator's protocol-fee cut, and an initial price; resolves the active bin on
 * the discrete bin grid and shows the real resolved price back (never a faked
 * exact match); guards against same-mint, Token-2022, and already-existing
 * pools; then builds the launch transactions on `@ponkrain/sdk` via
 * {@link createMarket}, has the connected wallet sign the create transaction
 * (vault ATAs + `initialize_pool` + the active bin array) and a best-effort
 * second `init_pool_treasury` transaction, and confirms each by polling the
 * signature status (WebSocket confirmation is unreliable on public RPCs).
 *
 * This mirrors the dex `app/rain/clouds/standard/page.tsx` flow exactly, but is
 * built entirely on the SDK and the scaffold's own components, so the kit ships
 * self-contained.
 *
 * Honesty rules upheld here:
 *  - The resolved bin price is the REAL on-chain value, shown back to the
 *    creator, not the typed input rounded to look exact.
 *  - A null / unresolvable price renders as a dash, never a guessed value.
 *  - Token-2022, same-mint, and pre-existing pools are rejected up front with a
 *    clear reason instead of letting `initialize_pool` fail cryptically on-chain
 *    after the creator has already paid a signature.
 */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  type AccountInfo,
  Connection,
  PublicKey,
  Transaction,
  type SignatureStatus,
} from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  binIdForPrice,
  createMarket,
  initPoolTreasuryIx,
  poolPda,
  priceOfBin,
  protocolFeePctOfTrade,
} from "@ponkrain/sdk";

import { Button } from "@/components/ui/Button";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TokenIcon } from "@/components/pools/TokenIcon";
import { TokenSelectModal } from "@/components/swap/TokenSelectModal";
import { TokenMetadataUpload } from "@/components/launch/TokenMetadataUpload";
import { ponkCloudsConnection } from "@/lib/connection";

/**
 * A token the form has selected for either pool side. This is the minimal
 * surface the launch flow needs: the mint address, a display symbol, its
 * on-chain decimals (required to map the human price onto the bin grid), and an
 * optional logo. It matches what {@link TokenSelectModal} hands back.
 */
export interface LaunchToken {
  /** Base58 mint address. */
  address: string;
  /** Display symbol (short-mint fallback when unknown; never fabricated). */
  symbol: string;
  /** On-chain decimals; used to resolve the initial price to a bin id. */
  decimals: number;
  /** Optional logo URI; {@link TokenIcon} falls back to a monogram when null. */
  logoUri: string | null;
}

/**
 * Bin step presets in bps. Mirrors the dex create flow; smaller steps
 * concentrate liquidity tighter (lower slippage per bin), larger steps span a
 * wider price range. The live SOL/USDC Clouds pool runs at 4 bps.
 */
const BIN_STEP_PRESETS = [1, 2, 4, 5, 10, 20, 50, 100] as const;

/**
 * Base (swap) fee tier presets in bps: the fee a trader pays the pool per swap,
 * shared between LPs and (via the protocol/treasury cuts) the protocol.
 */
const BASE_FEE_PRESETS = [1, 4, 5, 10, 30, 100] as const;

/**
 * Protocol-fee presets: the creator's cut OF the swap fee, in bps (10000 =
 * 100% of the fee). On Ponk this accrues to the pool CREATOR, something most
 * DLMMs never let creators keep. The creator picks it at create time and can
 * change it on-chain later as the pool authority. 0 means LPs keep the whole
 * fee (minus the platform's flat 1% treasury cut). The default is a modest 20%
 * so a creator earns by default without starving LPs.
 */
const PROTOCOL_FEE_PRESETS = [0, 1000, 2000, 3000] as const;
const DEFAULT_PROTOCOL_FEE_BPS = 2000;

/** Default bin step / base fee, matching the live SOL/USDC Clouds pool. */
const DEFAULT_BIN_STEP = 4;
const DEFAULT_BASE_FEE_BPS = 4;

/** SPL Token-2022 program. Ponk Clouds supports only classic SPL tokens, so a
 * mint owned by this program is rejected before building the create tx. */
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Classic SPL Token program; a usable mint must be owned by exactly this. */
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type Phase = "idle" | "submitting" | "done" | "error";

/** Round a price for display without faking precision. Returns a dash for a
 * null / non-finite / non-positive price (the honesty rule at the leaf). */
function showPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p) || p <= 0) return "--";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

/** A short, copyable label for a pool address (Xxxx..Xxxx). */
function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}..${addr.slice(-6)}` : addr;
}

/**
 * Confirm a sent transaction by POLLING `getSignatureStatus`, not by trusting
 * the WebSocket-based `confirmTransaction`. Public RPC nodes routinely drop the
 * `signatureSubscribe` notification, so the blockhash strategy throws
 * "block height exceeded" while the transaction has in fact landed, leaving the
 * UI stuck. Direct status polling is authoritative: it returns as soon as the
 * signature is confirmed/finalized, surfaces a real on-chain error, and only
 * fails once the block height is truly past the blockhash's last-valid slot AND
 * a final history lookup still cannot find it. Ported from the dex `confirmSig`.
 */
async function confirmSignature(
  conn: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const st: SignatureStatus | null = value[0];
    if (st) {
      if (st.err) {
        // The tx landed but failed on-chain. Pull the confirmed transaction's
        // log tail so the thrown error names the failing program/instruction.
        let tail = "";
        try {
          const tx = await conn.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const logs = tx?.meta?.logMessages;
          if (logs?.length) tail = ` - ${logs.slice(-3).join(" | ")}`;
        } catch {
          // Best-effort only; fall back to the bare message below.
        }
        throw new Error(`transaction failed on-chain${tail}`);
      }
      if (
        st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    let height: number;
    try {
      height = await conn.getBlockHeight("confirmed");
    } catch {
      await sleep(2000);
      continue;
    }
    if (height > lastValidBlockHeight) {
      const final = (
        await conn.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (final && !final.err) return;
      throw new Error(
        "transaction expired before it confirmed - nothing was submitted, try again",
      );
    }
    await sleep(2000);
  }
}

/**
 * The Ponk Rain create-DLMM form. Self-contained: it manages its own token
 * selection, parameter, and submission state, and owns the wallet sign + send +
 * confirm flow. Mounted by `/launch`.
 */
export function LaunchForm() {
  const { publicKey, signTransaction } = useWallet();

  const [base, setBase] = useState<LaunchToken | null>(null);
  const [quote, setQuote] = useState<LaunchToken | null>(null);
  const [tokenModal, setTokenModal] = useState<"base" | "quote" | null>(null);

  const [binStep, setBinStep] = useState<number>(DEFAULT_BIN_STEP);
  const [baseFeeBps, setBaseFeeBps] = useState<number>(DEFAULT_BASE_FEE_BPS);
  // The creator's cut OF the swap fee (bps), earned by them on every swap.
  const [protocolFeeBps, setProtocolFeeBps] = useState<number>(
    DEFAULT_PROTOCOL_FEE_BPS,
  );
  const [priceInput, setPriceInput] = useState("");

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  // Whether the best-effort second (treasury) signature landed. Null until the
  // pool is created; true/false once the treasury follow-up resolves, driving
  // an honest note so the copy never over-promises a single signature.
  const [treasuryDone, setTreasuryDone] = useState<boolean | null>(null);

  // Base = X, Quote = Y. The program does NOT canonicalize mint order, so the
  // creator's choice of which side is base/quote is part of the pool identity
  // (and its PDA seed). The initial price is quote-per-base, exactly the axis
  // priceOfBin / binIdForPrice use.
  const price = useMemo(() => {
    const n = Number(priceInput);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [priceInput]);

  const activeBinId = useMemo(() => {
    if (!base || !quote || price === null) return null;
    return binIdForPrice(price, binStep, base.decimals, quote.decimals);
  }, [base, quote, price, binStep]);

  // The bin grid is discrete, so the real initial price of the resolved bin
  // differs slightly from what the creator typed. Show it back so they confirm
  // the actual on-chain value, never a fabricated exact match.
  const resolvedPrice = useMemo(() => {
    if (activeBinId === null || !base || !quote) return null;
    return priceOfBin(activeBinId, binStep, base.decimals, quote.decimals);
  }, [activeBinId, base, quote, binStep]);

  const poolAddress = useMemo(() => {
    if (!base || !quote) return null;
    try {
      return poolPda(
        new PublicKey(base.address),
        new PublicKey(quote.address),
        binStep,
      ).toBase58();
    } catch {
      return null;
    }
  }, [base, quote, binStep]);

  const sameMint =
    base !== null && quote !== null && base.address === quote.address;

  const canCreate =
    !!publicKey &&
    !!signTransaction &&
    base !== null &&
    quote !== null &&
    !sameMint &&
    activeBinId !== null &&
    phase !== "submitting";

  const onSelect = useCallback(
    (token: LaunchToken) => {
      if (tokenModal === "base") setBase(token);
      else if (tokenModal === "quote") setQuote(token);
      setTokenModal(null);
    },
    [tokenModal],
  );

  async function doCreate() {
    if (
      !publicKey ||
      !signTransaction ||
      !base ||
      !quote ||
      activeBinId === null
    ) {
      return;
    }
    // Defense in depth: the Create button is already disabled for an identical
    // base/quote, but a same-mint pool is a degenerate single-token pool the
    // program does NOT reject on-chain, so never rely on the button alone.
    if (base.address === quote.address) {
      setPhase("error");
      setMessage("Base and quote must be different tokens.");
      return;
    }

    setPhase("submitting");
    setMessage(null);
    setSig(null);
    setTreasuryDone(null);
    try {
      const mintX = new PublicKey(base.address);
      const mintY = new PublicKey(quote.address);
      const conn = ponkCloudsConnection();

      // Ponk Clouds uses the classic SPL Token program only (the program's
      // vaults are Account<TokenAccount>, not the Token-2022 interface). A
      // Token-2022 (or non-mint) account would fail with a cryptic ATA
      // "incorrect program id" error, so reject it up front with a clear reason.
      const [mxInfo, myInfo] = await conn.getMultipleAccountsInfo([
        mintX,
        mintY,
      ]);
      const owners: Array<[AccountInfo<Buffer> | null, LaunchToken]> = [
        [mxInfo, base],
        [myInfo, quote],
      ];
      for (const [info, tok] of owners) {
        // A mint that does not exist (e.g. a pasted bad address) returns null.
        // Reject it with a clear message instead of letting initialize_pool
        // fail with a cryptic vault/TokenAccount constraint error later.
        if (!info) {
          throw new Error(
            `could not load the ${tok.symbol} mint - check the address and try again`,
          );
        }
        const owner = info.owner.toBase58();
        if (owner === TOKEN_2022_PROGRAM) {
          throw new Error(
            "Token-2022 tokens are not supported by Ponk Clouds yet. Pick classic SPL tokens.",
          );
        }
        if (owner !== TOKEN_PROGRAM) {
          throw new Error(
            `${tok.symbol} is not a classic SPL token, so it can't be used in a Ponk Clouds pool`,
          );
        }
      }

      // Refuse to re-init an existing pool: initialize_pool would fail on-chain,
      // and silently sending it wastes the creator's fee. Honest pre-check.
      const poolKey = poolPda(mintX, mintY, binStep);
      const existing = await conn.getAccountInfo(poolKey);
      if (existing) {
        throw new Error(
          "a Ponk Clouds pool already exists for this pair and bin step",
        );
      }

      // Build the launch plan on the SDK: CU budget + the two pool-vault ATAs +
      // initialize_pool + the active bin array (so the market is immediately
      // swappable/seedable), plus the SEPARATE best-effort treasury init.
      const plan = createMarket({
        authority: publicKey,
        mintX,
        mintY,
        decimalsX: base.decimals,
        decimalsY: quote.decimals,
        binStep,
        baseFeeBps,
        protocolFeeBps,
        initialPrice: price!,
      });

      // CREATE the pool in its own minimal transaction. Keeping it minimal
      // avoids tx-size issues and lets the treasury init be a separate,
      // non-blocking follow-up so a treasury hiccup never blocks pool creation.
      const createTx = new Transaction().add(...plan.createIxs);
      const bh1 = await conn.getLatestBlockhash("confirmed");
      createTx.feePayer = publicKey;
      createTx.recentBlockhash = bh1.blockhash;
      const signedCreate = await signTransaction(createTx);
      const signature = await conn.sendRawTransaction(
        signedCreate.serialize(),
        { skipPreflight: false },
      );
      await confirmSignature(conn, signature, bh1.lastValidBlockHeight);

      setSig(signature);
      setPhase("done");
      setMessage("Pool created. You are its authority.");

      // BEST-EFFORT: set up the per-pool treasury PDA so the platform's 1% fee
      // routes from the first swap. A separate tx so any failure here cannot
      // undo or block the (already confirmed) pool creation.
      try {
        const treasuryTx = new Transaction().add(
          initPoolTreasuryIx({ authority: publicKey, pool: poolKey }),
        );
        const bh2 = await conn.getLatestBlockhash("confirmed");
        treasuryTx.feePayer = publicKey;
        treasuryTx.recentBlockhash = bh2.blockhash;
        const signedTreasury = await signTransaction(treasuryTx);
        const tSig = await conn.sendRawTransaction(
          signedTreasury.serialize(),
          { skipPreflight: false },
        );
        await confirmSignature(conn, tSig, bh2.lastValidBlockHeight);
        setTreasuryDone(true);
      } catch {
        // Pool is live regardless; treasury can be initialized later. Record the
        // miss so the done state can honestly say it was skipped.
        setTreasuryDone(false);
      }
    } catch (e) {
      setPhase("error");
      // Surface the on-chain logs when the wallet/RPC attached them, so a
      // simulation failure is actionable instead of a one-line mystery.
      const logs = (e as { logs?: string[] } | null)?.logs;
      const msg = e instanceof Error ? e.message : "could not create the pool";
      setMessage(
        logs?.length ? `${msg} - ${logs.slice(-3).join(" | ")}` : msg,
      );
    }
  }

  const tokenButton = (
    side: "base" | "quote",
    picked: LaunchToken | null,
    label: string,
  ) => (
    <div className="flex flex-1 flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.06em] text-fg2">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setTokenModal(side)}
        className="flex h-12 items-center gap-2.5 rounded-[10px] border border-line bg-panel2 px-3 text-left transition-colors hover:border-pink/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink/50"
      >
        {picked ? (
          <>
            <TokenIcon
              mint={picked.address}
              symbol={picked.symbol}
              logoUri={picked.logoUri}
              size={24}
            />
            <span className="min-w-0 truncate text-[14px] font-semibold text-fg">
              {picked.symbol}
            </span>
          </>
        ) : (
          <span className="text-[14px] text-fg2">Select token</span>
        )}
        <span className="ml-auto flex-none text-fg2" aria-hidden>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-5">
      {/* token pair */}
      <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4">
        <h2 className="m-0 text-[13px] font-semibold text-fg">Token pair</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {tokenButton("base", base, "Base token")}
          <span
            className="hidden flex-none pb-3 text-fg2 sm:inline"
            aria-hidden
          >
            /
          </span>
          {tokenButton("quote", quote, "Quote token")}
        </div>
        {sameMint ? (
          <p className="m-0 text-[11px] text-neg">
            Base and quote must be different tokens.
          </p>
        ) : (
          <p className="m-0 text-[11px] leading-relaxed text-fg2">
            The base/quote order is part of the pool identity and is not
            reordered for you. Price is quoted as quote per base.
          </p>
        )}
      </section>

      {/* optional token metadata for a brand-new token the creator is launching.
          Skipping it is fine: the symbol then falls back to the on-chain
          short-mint, nothing is fabricated. */}
      <TokenMetadataUpload />

      {/* bin step */}
      <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 text-[13px] font-semibold text-fg">Bin step</h2>
          <span className="font-mono text-[11px] tabular-nums text-fg2">
            {binStep} bps
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {BIN_STEP_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setBinStep(s)}
              className={
                "rounded-[8px] border px-3 py-1.5 font-mono text-[12px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink/50 " +
                (binStep === s
                  ? "border-pink/50 bg-pink/15 text-pink"
                  : "border-line bg-panel2 text-fg2 hover:border-pink/30 hover:text-fg")
              }
            >
              {s}
            </button>
          ))}
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-fg2">
          Smaller bin steps concentrate liquidity tighter for lower slippage;
          larger steps span a wider price range per bin.
        </p>
      </section>

      {/* base fee tier */}
      <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 text-[13px] font-semibold text-fg">
            Base fee tier
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-fg2">
            {(baseFeeBps / 100).toFixed(2)}%
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {BASE_FEE_PRESETS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setBaseFeeBps(f)}
              className={
                "rounded-[8px] border px-3 py-1.5 font-mono text-[12px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink/50 " +
                (baseFeeBps === f
                  ? "border-pink/50 bg-pink/15 text-pink"
                  : "border-line bg-panel2 text-fg2 hover:border-pink/30 hover:text-fg")
              }
            >
              {(f / 100).toFixed(2)}%
            </button>
          ))}
        </div>
      </section>

      {/* your protocol fee: the creator's cut, the part most DLMMs keep */}
      <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 text-[13px] font-semibold text-fg">
            Your protocol fee
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-fg2">
            {(protocolFeeBps / 100).toFixed(0)}% of the swap fee
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {PROTOCOL_FEE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProtocolFeeBps(p)}
              className={
                "rounded-[8px] border px-3 py-1.5 font-mono text-[12px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink/50 " +
                (protocolFeeBps === p
                  ? "border-pink/50 bg-pink/15 text-pink"
                  : "border-line bg-panel2 text-fg2 hover:border-pink/30 hover:text-fg")
              }
            >
              {p === 0 ? "0%" : `${(p / 100).toFixed(0)}%`}
            </button>
          ))}
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-fg2">
          The slice of the swap fee you earn as the pool creator, on every swap,
          for the life of the pool.
          {protocolFeeBps > 0
            ? ` That works out to about ${protocolFeePctOfTrade(
                protocolFeeBps,
                baseFeeBps,
              )} of each trade.`
            : " At 0% LPs keep the whole fee (minus the platform's flat 1%)."}
        </p>
      </section>

      {/* creator economics: the honest fee model, set up automatically */}
      <section className="flex flex-col gap-2.5 rounded-[12px] border border-pink/30 bg-pink/[0.06] p-4">
        <h2 className="m-0 text-[13px] font-semibold text-pink">
          You create it, you earn the fee
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12px] leading-relaxed text-fg">
          <li className="flex gap-2">
            <span className="flex-none text-pink" aria-hidden>
              &bull;
            </span>
            You set the protocol fee above and earn it on every swap, for the
            life of the pool.
          </li>
          <li className="flex gap-2">
            <span className="flex-none text-pink" aria-hidden>
              &bull;
            </span>
            {protocolFeeBps > 0
              ? `Of each swap fee, you keep ${(protocolFeeBps / 100).toFixed(
                  0,
                )}%, the platform takes 1%, and LPs keep the rest (about ${(
                  100 -
                  protocolFeeBps / 100 -
                  1
                ).toFixed(0)}%).`
              : "Of each swap fee, the platform takes 1% and LPs keep the rest (about 99%)."}
          </li>
          <li className="flex gap-2">
            <span className="flex-none text-pink" aria-hidden>
              &bull;
            </span>
            A 1% platform fee on the swap fee funds the protocol. Its treasury is
            set up automatically right after the pool is created, in a quick
            second signature, so nothing else is required from you.
          </li>
        </ul>
      </section>

      {/* initial price */}
      <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4">
        <h2 className="m-0 text-[13px] font-semibold text-fg">Initial price</h2>
        <label className="flex items-center gap-2.5 rounded-[10px] border border-line bg-panel2 px-3 py-2.5 transition-colors focus-within:border-pink/40">
          <span className="flex-none text-[12px] text-fg2">
            {base && quote ? `${quote.symbol} per ${base.symbol}` : "Price"}
          </span>
          <input
            className="h-6 w-full min-w-0 border-0 bg-transparent text-right font-mono text-[16px] text-fg outline-none placeholder:text-fg2"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            aria-label="Initial price (quote per base)"
          />
        </label>
        <div className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-panel2 px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-fg2">Active bin</span>
            <span className="font-mono tabular-nums text-fg">
              {activeBinId !== null ? activeBinId : "--"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg2">Resolved bin price</span>
            <span className="font-mono tabular-nums text-fg">
              {resolvedPrice !== null && base && quote
                ? `${showPrice(resolvedPrice)} ${quote.symbol}/${base.symbol}`
                : "--"}
            </span>
          </div>
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-fg2">
          Prices live on a discrete bin grid, so the active bin&apos;s exact
          price differs slightly from what you type. The resolved value above is
          what the pool will open at.
        </p>
      </section>

      {/* pool address preview */}
      {poolAddress ? (
        <div className="flex items-center justify-between rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-[11px]">
          <span className="text-fg2">Pool address</span>
          <span className="ml-2 min-w-0 truncate font-mono tabular-nums text-fg">
            {poolAddress}
          </span>
        </div>
      ) : null}

      {/* status */}
      {message ? (
        <p
          className={
            "m-0 rounded-[8px] border px-3 py-2 text-[12px] " +
            (phase === "error"
              ? "border-neg/30 bg-neg/[0.06] text-neg"
              : phase === "done"
                ? "border-pos/30 bg-pos/[0.06] text-pos"
                : "border-line bg-panel2 text-fg2")
          }
        >
          {message}
          {sig ? (
            <a
              className="ml-1 font-mono underline"
              href={`https://solscan.io/tx/${sig}`}
              target="_blank"
              rel="noreferrer"
            >
              ({sig.slice(0, 8)}..)
            </a>
          ) : null}
        </p>
      ) : null}

      {phase === "done" && treasuryDone === false ? (
        <p className="m-0 rounded-[8px] border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[11px] leading-relaxed text-warn">
          The pool is live, but its protocol treasury was not initialized (the
          second signature was skipped or rejected). The 1% platform fee has no
          destination until the treasury is set up; it can be initialized later.
        </p>
      ) : null}

      {phase === "done" && base && quote && poolAddress ? (
        <Link
          href={`/pool/${poolAddress}?action=add`}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] border border-pink/40 bg-pink/15 px-5 text-[14px] font-semibold text-pink no-underline transition-colors hover:bg-pink/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink/50"
          aria-label={`Open pool ${shorten(poolAddress)} and add liquidity`}
        >
          Open pool and add liquidity
        </Link>
      ) : !publicKey ? (
        // Pre-connect: the single connect entry point. The wallet modal opens
        // from here; once connected the Create button takes over.
        <WalletButton />
      ) : (
        <Button
          variant="primary"
          size="md"
          disabled={!canCreate}
          onClick={doCreate}
        >
          {phase === "submitting"
            ? "Confirm in wallet..."
            : !base || !quote
              ? "Select both tokens"
              : sameMint
                ? "Pick two different tokens"
                : activeBinId === null
                  ? "Set an initial price"
                  : "Create pool"}
        </Button>
      )}

      <p className="m-0 text-[10px] leading-relaxed text-fg2">
        Non-custodial. The first signature creates the two pool vaults, the
        active bin array, and initializes the pool; a quick second signature
        sets up its protocol treasury. Nothing is deposited yet. Add liquidity
        from the pool page once it exists.
      </p>

      <TokenSelectModal
        open={tokenModal === "base"}
        title="Select base token"
        exclude={quote?.address ?? null}
        onClose={() => setTokenModal(null)}
        onSelect={onSelect}
      />
      <TokenSelectModal
        open={tokenModal === "quote"}
        title="Select quote token"
        exclude={base?.address ?? null}
        onClose={() => setTokenModal(null)}
        onSelect={onSelect}
      />
    </div>
  );
}
