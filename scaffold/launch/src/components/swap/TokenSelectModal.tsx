"use client";

/**
 * TokenSelectModal - the token picker for the Ponk Rain launch form.
 *
 * Self-contained (no `@ponk/ui` / shared-types / settings-store dependency) so
 * the launch kit ships standalone. It lets a creator pick either pool side by:
 *
 *   - choosing from a small curated list of canonical mints (wSOL, USDC), or
 *   - pasting ANY classic SPL mint address, whose decimals are then read
 *     straight from chain via `getMint` so the resolved {@link LaunchToken}
 *     carries the REAL on-chain decimals the price->bin mapping depends on.
 *
 * It hands the caller a {@link LaunchToken} (`{ address, symbol, decimals,
 * logoUri }`), exactly what {@link LaunchForm} consumes.
 *
 * HONESTY (no fabrication):
 *   - A pasted mint is validated as a real pubkey AND confirmed to be a classic
 *     SPL mint on-chain before it can be selected; a non-existent or Token-2022
 *     account is rejected with a clear reason rather than silently accepted.
 *   - The symbol of a pasted, unindexed mint falls back to a short-mint label;
 *     it is never given a made-up ticker. The logo is null unless one is known.
 *   - Decimals come from chain, never guessed. A failed lookup blocks selection
 *     with an explicit error.
 *
 * The modal is a plain, accessible overlay (Escape to close, backdrop click to
 * dismiss, focus moved to the search field on open). No portal library is used;
 * it renders inline with a fixed-position backdrop.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

import { TokenIcon } from "@/components/pools/TokenIcon";
import { ponkCloudsConnection } from "@/lib/connection";
import { shortenAddress } from "@/lib/format";
import {
  NATIVE_MINT_STR,
  USDC_MINT_STR,
  NATIVE_DECIMALS,
  USDC_DECIMALS,
  TOKEN_2022_PROGRAM_STR,
  TOKEN_PROGRAM_STR,
} from "@/lib/config";
import type { LaunchToken } from "@/components/launch/LaunchForm";

/**
 * A curated, always-available entry. Decimals are the known on-chain decimals of
 * these canonical mints, so they never require a lookup. The logo is null; the
 * {@link TokenIcon} renders a stable monogram (we do not bundle remote logos).
 */
interface CuratedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** The canonical mints offered without a lookup (the common quote sides). */
const CURATED: CuratedToken[] = [
  {
    address: NATIVE_MINT_STR,
    symbol: "SOL",
    name: "Wrapped SOL",
    decimals: NATIVE_DECIMALS,
  },
  {
    address: USDC_MINT_STR,
    symbol: "USDC",
    name: "USD Coin",
    decimals: USDC_DECIMALS,
  },
];

/** Does the string look like a base58 Solana mint address? */
function looksLikeMint(q: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.trim());
}

/** The lookup phase for a pasted mint. */
type LookupPhase = "idle" | "loading" | "error";

/** Props for {@link TokenSelectModal}. */
export interface TokenSelectModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** The modal title (e.g. "Select base token"). */
  title: string;
  /** Address to exclude (the other side of the pair), or null. */
  exclude?: string | null;
  /** Close the modal without selecting. */
  onClose: () => void;
  /** Called with the chosen token; the caller closes the modal. */
  onSelect: (token: LaunchToken) => void;
}

/**
 * The token picker modal. Shows the curated mints filtered by a search box, and
 * resolves a pasted mint's on-chain decimals before allowing its selection.
 *
 * @param open - whether the modal is shown.
 * @param title - the modal heading.
 * @param exclude - the other pair side's mint, hidden from the list.
 * @param onClose - dismiss callback.
 * @param onSelect - selection callback, handed a resolved {@link LaunchToken}.
 */
export function TokenSelectModal({
  open,
  title,
  exclude,
  onClose,
  onSelect,
}: TokenSelectModalProps) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<LookupPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  // The resolved-from-chain token for a pasted mint, ready to select.
  const [resolved, setResolved] = useState<LaunchToken | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);

  // Reset transient state and focus the search box each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPhase("idle");
    setError(null);
    setResolved(null);
    // Focus after paint so the element exists.
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const excluded = useCallback(
    (addr: string) => exclude != null && addr === exclude,
    [exclude],
  );

  // The curated rows matching the current (non-address) search query.
  const curatedMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CURATED.filter((t) => !excluded(t.address)).filter(
      (t) =>
        q === "" ||
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q),
    );
  }, [query, excluded]);

  const isAddressQuery = looksLikeMint(query);

  /**
   * Resolve a pasted mint from chain: confirm it is owned by the classic SPL
   * Token program and read its decimals via `getMint`. Token-2022 and
   * non-existent accounts are rejected with a clear reason. On success the
   * resolved {@link LaunchToken} is stashed so the user can confirm it.
   */
  const resolveMint = useCallback(async () => {
    const raw = query.trim();
    setPhase("loading");
    setError(null);
    setResolved(null);
    try {
      let mint: PublicKey;
      try {
        mint = new PublicKey(raw);
      } catch {
        throw new Error("that is not a valid mint address");
      }
      if (excluded(mint.toBase58())) {
        throw new Error("that token is already the other side of the pair");
      }
      const conn = ponkCloudsConnection();
      // Reject Token-2022 up front: Ponk Clouds vaults take classic SPL mints
      // only, so a Token-2022 mint could never be used in a pool. `getMint`
      // would also throw, but this gives the precise reason.
      const info = await conn.getAccountInfo(mint);
      if (!info) {
        throw new Error("no mint exists at that address on this RPC");
      }
      const owner = info.owner.toBase58();
      if (owner === TOKEN_2022_PROGRAM_STR) {
        throw new Error(
          "Token-2022 mints are not supported by Ponk Clouds yet",
        );
      }
      if (owner !== TOKEN_PROGRAM_STR) {
        throw new Error("that account is not a classic SPL token mint");
      }
      const decoded = await getMint(conn, mint);
      setResolved({
        address: mint.toBase58(),
        // No indexer here: fall back to a short-mint label, never a fake ticker.
        symbol: shortenAddress(mint.toBase58()),
        decimals: decoded.decimals,
        logoUri: null,
      });
      setPhase("idle");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "could not load that mint");
    }
  }, [query, excluded]);

  const selectCurated = useCallback(
    (t: CuratedToken) => {
      onSelect({
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        logoUri: null,
      });
    },
    [onSelect],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // Dismiss only when the backdrop itself is clicked, not the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-[440px] flex-col gap-3 rounded-card border border-line bg-panel p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-[14px] font-semibold text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-fg"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <input
          ref={searchRef}
          className="h-11 w-full rounded-card border border-line bg-elevated px-3 font-mono text-[13px] text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-pink/60"
          placeholder="Search symbol or paste a mint address"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setError(null);
            setResolved(null);
            setPhase("idle");
          }}
          aria-label="Search tokens"
        />

        {/* Pasted-mint resolver: confirm on-chain decimals before selection. */}
        {isAddressQuery ? (
          <div className="flex flex-col gap-2 rounded-card border border-line bg-elevated px-3 py-2.5">
            {resolved ? (
              <button
                type="button"
                onClick={() => onSelect(resolved)}
                className="flex items-center gap-2.5 text-left"
              >
                <TokenIcon
                  mint={resolved.address}
                  symbol={resolved.symbol}
                  logoUri={resolved.logoUri}
                  size={28}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-semibold text-fg">
                    {resolved.symbol}
                  </span>
                  <span className="font-mono text-[10px] text-muted">
                    {resolved.decimals} decimals - confirmed on-chain
                  </span>
                </span>
                <span className="ml-auto text-[11px] font-semibold text-pink">
                  Select
                </span>
              </button>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                  {query.trim()}
                </span>
                <button
                  type="button"
                  onClick={resolveMint}
                  disabled={phase === "loading"}
                  className="flex-none rounded-card border border-pink/40 bg-pink/15 px-3 py-1.5 text-[12px] font-semibold text-pink transition-colors hover:bg-pink/25 disabled:opacity-60"
                >
                  {phase === "loading" ? "Checking..." : "Look up mint"}
                </button>
              </div>
            )}
            {error ? (
              <p className="m-0 text-[11px] text-negative">{error}</p>
            ) : null}
          </div>
        ) : null}

        {/* Curated list. */}
        <div
          className="flex max-h-[300px] flex-col gap-1 overflow-y-auto"
          role="listbox"
          aria-label="Token results"
        >
          {curatedMatches.length === 0 && !isAddressQuery ? (
            <p className="m-0 py-6 text-center font-mono text-[11px] text-muted">
              No curated token matches. Paste a mint address to use any classic
              SPL token.
            </p>
          ) : (
            curatedMatches.map((t) => (
              <button
                key={t.address}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => selectCurated(t)}
                className="flex items-center gap-2.5 rounded-card px-2 py-2 text-left transition-colors hover:bg-elevated"
              >
                <TokenIcon mint={t.address} symbol={t.symbol} size={28} />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="text-[13px] font-semibold text-fg">
                    {t.symbol}
                  </span>
                  <span className="text-[11px] text-muted">{t.name}</span>
                </span>
                <span className="ml-auto flex-none font-mono text-[10px] text-muted">
                  {shortenAddress(t.address)}
                </span>
              </button>
            ))
          )}
        </div>

        <p className="m-0 text-[10px] leading-relaxed text-muted">
          Any classic SPL token works. Paste its mint address and the kit reads
          the real on-chain decimals before you select it. Token-2022 mints are
          not supported by Ponk Clouds yet.
        </p>
      </div>
    </div>
  );
}
