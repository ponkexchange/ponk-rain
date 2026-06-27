/**
 * Persistent site footer for `@ponkrain/launch`.
 *
 * Mounted once by the root layout, pinned below the page content. It carries
 * the honesty disclaimer the whole product is held to (the Ponk Clouds program
 * is UNAUDITED and there is ZERO protocol fee at the AMM level) and a verifiable
 * link to the on-chain program id on Solscan, so a visitor can confirm the
 * venue's program for themselves.
 *
 * This is a server component: it renders only static, compile-time config
 * ({@link BRAND_NAME}, {@link VENUE_NAME}, {@link PROGRAM_ID_STR}) and a plain
 * Solscan link, with no browser-only state.
 */

import { BRAND_NAME, VENUE_NAME, PROGRAM_ID_STR, solscanAddressUrl } from "@/lib/config";

/**
 * App-wide footer: disclaimer copy plus the verifiable program id. Takes no
 * props; it is mounted once by the root layout.
 */
export function Footer() {
  return (
    <footer className="mt-12 border-t border-line bg-bg">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-[12px] leading-relaxed text-muted sm:px-6">
        <p className="m-0">
          {BRAND_NAME} is a non-custodial interface to {VENUE_NAME}, a bin-based
          DLMM AMM on Solana with zero protocol fee at the AMM level. The swap
          fee flows to LPs and the pool creator, not to the AMM.
        </p>
        <p className="m-0 font-medium text-fg">
          UNAUDITED software. Use at your own risk. Nothing here is financial
          advice.
        </p>
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Program</span>
          <a
            href={solscanAddressUrl(PROGRAM_ID_STR)}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all font-mono text-[11px] text-muted underline decoration-line underline-offset-2 transition-colors hover:text-pink"
          >
            {PROGRAM_ID_STR}
          </a>
        </p>
      </div>
    </footer>
  );
}
