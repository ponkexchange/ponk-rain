"use client";

/**
 * A token's circular avatar for pool rows and pair marks.
 *
 * Honesty rule: the only logo this renders is the real `logoUri` the backend
 * stamped on the pool's token leg (`GET /clouds/pools` -> `tokenX/tokenY.logoUri`).
 * When that is null/empty, or the image fails to load, we fall back to a stable
 * monogram derived from the symbol/mint, never a fabricated or guessed image.
 * The backend logo is routed through the wsrv image proxy so every icon is a
 * uniform circle regardless of the source image's aspect ratio.
 */

import { useState } from "react";

/** Deterministic hue from a mint/symbol so a token's monogram color is stable. */
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}

/**
 * Proxy a real logo through wsrv for fixed sizing + a circle mask, so every row
 * icon is uniform regardless of the source image's aspect ratio.
 *
 * @param src The real logo URL (from the backend).
 * @param px The pixel size to fetch at (typically 2x the rendered size).
 */
function proxied(src: string, px: number): string {
  return `https://wsrv.nl/?w=${px}&h=${px}&fit=cover&mask=circle&url=${encodeURIComponent(src)}`;
}

/** Props for {@link TokenIcon}. */
export interface TokenIconProps {
  /** Mint address, base58. Used to seed the monogram fallback color. */
  mint: string;
  /** Token symbol; its first chars form the monogram fallback. */
  symbol: string;
  /** Rendered diameter in px (default 28). */
  size?: number;
  /**
   * The real backend logo for this token, or null/undefined when none is known.
   * When present it is the only image source; when absent we render the stable
   * monogram. Never fabricated.
   */
  logoUri?: string | null;
}

/**
 * One token's circular avatar. Renders the real backend `logoUri` when present
 * (proxied for uniform circular sizing), otherwise a deterministic monogram.
 */
export function TokenIcon({ mint, symbol, size = 28, logoUri }: TokenIconProps) {
  const [failed, setFailed] = useState(false);
  const logo = logoUri && logoUri.trim() ? logoUri.trim() : null;
  const initials =
    (symbol || "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 3)
      .toUpperCase() || "?";

  if (failed || !logo) {
    const h = hueOf(mint || symbol || "?");
    return (
      <span
        aria-hidden
        className="inline-flex flex-none items-center justify-center rounded-full font-mono font-medium text-white/90 ring-1 ring-white/10"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.34),
          background: `linear-gradient(140deg, hsl(${h} 42% 24%), hsl(${(h + 38) % 360} 44% 13%))`,
        }}
      >
        {initials.slice(0, 2)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={proxied(logo, Math.round(size * 2))}
      alt={symbol}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="flex-none rounded-full bg-panel2 object-cover ring-1 ring-white/10"
      style={{ width: size, height: size }}
    />
  );
}

/** Props for {@link PairIcon}. */
export interface PairIconProps {
  /** Base-token (X) mint, base58. */
  xMint: string;
  /** Base-token (X) symbol. */
  xSymbol: string;
  /** Quote-token (Y) mint, base58. */
  yMint: string;
  /** Quote-token (Y) symbol. */
  ySymbol: string;
  /** Rendered diameter of each icon in px (default 28). */
  size?: number;
  /** Real backend logo for the X side, or null/undefined when unknown. */
  xLogoUri?: string | null;
  /** Real backend logo for the Y side, or null/undefined when unknown. */
  yLogoUri?: string | null;
}

/** Two token icons overlapped, the classic DEX pair mark. */
export function PairIcon({
  xMint,
  xSymbol,
  yMint,
  ySymbol,
  size = 28,
  xLogoUri,
  yLogoUri,
}: PairIconProps) {
  const overlap = Math.round(size * 0.62);
  return (
    <span
      className="relative inline-flex flex-none items-center"
      style={{ width: size + overlap, height: size }}
    >
      <span className="absolute left-0 top-0 rounded-full ring-2 ring-panel">
        <TokenIcon mint={xMint} symbol={xSymbol} size={size} logoUri={xLogoUri} />
      </span>
      <span
        className="absolute top-0 rounded-full ring-2 ring-panel"
        style={{ left: overlap }}
      >
        <TokenIcon mint={yMint} symbol={ySymbol} size={size} logoUri={yLogoUri} />
      </span>
    </span>
  );
}
