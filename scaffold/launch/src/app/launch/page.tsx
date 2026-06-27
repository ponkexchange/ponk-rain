/**
 * /launch - Ponk Rain: create a Ponk Clouds DLMM.
 *
 * "Clouds" is PONK's bin-based DLMM AMM (program id
 * `DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M`); "Rain" is the act of
 * creating one. This is a client page (it needs the wallet) that renders the
 * {@link LaunchForm}: pick a base + quote mint, a bin step preset, a base swap
 * fee tier, the creator's protocol-fee cut, and the initial price; the form
 * resolves the active bin, builds the launch transactions on `@ponkrain/sdk`
 * via {@link createMarket}, has the connected wallet sign them, and confirms by
 * polling the signature. On success it links to the new pool's add-liquidity
 * flow.
 *
 * It mirrors the dex `app/rain/clouds/standard/page.tsx` create flow exactly,
 * but builds against the SDK rather than the dex-local instruction helpers.
 *
 * The page itself stays thin: it is a heading + the form, laid out as a single
 * in-flow column (not a modal) so the top never clips on short viewports.
 */

import type { Metadata } from "next";
import { LaunchForm } from "@/components/launch/LaunchForm";

export const metadata: Metadata = {
  title: "Launch a market - Ponk Rain",
  description:
    "Create a Ponk Clouds DLMM: pick a token pair, bin step, base fee tier, " +
    "creator protocol fee, and initial price. Your wallet signs the on-chain " +
    "initialize and you become the pool authority. Zero protocol fee at the AMM level.",
};

/**
 * The /launch route. A server component shell that renders the client
 * {@link LaunchForm}; all wallet/RPC interaction lives in the form so this
 * boundary can stay static and render the surrounding copy on the server.
 */
export default function LaunchPage() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-col gap-5 px-4 pb-16 pt-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="m-0 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-fg">
            Ponk Rain
          </h1>
          <span className="rounded-full border border-pink/40 bg-pink/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-pink">
            Create DLMM
          </span>
        </div>
        <p className="m-0 text-[13px] leading-relaxed text-fg2">
          Rain a new Ponk Clouds DLMM: pick a base and quote token, a bin step, a
          base fee tier and the initial price. Your wallet signs the on-chain
          initialize and you become the pool authority. There is zero protocol
          fee at the AMM level; the only cut is the slice of the swap fee you set
          below.
        </p>
      </header>

      <LaunchForm />
    </main>
  );
}
