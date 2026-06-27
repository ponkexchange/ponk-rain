import Link from "next/link";

import { PoolList } from "@/components/pools/PoolList";
import type { PoolListItem } from "@/components/pools/PoolCard";
import { StatBar } from "@/components/analytics/StatBar";
import { getPools, getStats } from "@/lib/api";

/** Brand name shown in the hero copy. Mirrors `lib/config.ts`; inlined here so
 * the home page does not couple to that module's export naming. */
const APP_NAME = "Ponk Rain";

/** First-page size for the home pool list. The dedicated `/explore` page does
 * full server-side pagination; the home page only needs the top slice. */
const HOME_PAGE_SIZE = 24;

/**
 * Home / explore. The market's front door.
 *
 * A server component that, on every request, reads the platform rollup
 * (`GET /clouds/stats`) and the first page of discovered pools
 * (`GET /clouds/pools?sortBy=tvl:desc`) through the typed backend client, then
 * renders a hero with a live {@link StatBar} and a client {@link PoolList} for
 * browse / sort / search. Every metric is honest: a value the indexer has not
 * computed arrives as `null` and renders as `--`, never a fabricated number.
 *
 * Both reads are best-effort: if the backend is unreachable the page still
 * renders (empty stat bar, empty pool list with its honest empty state) rather
 * than throwing a 500, so a fresh clone-and-run points at a not-yet-running
 * indexer without white-screening.
 */

/** Always render fresh so newly rained pools and live metrics show up without
 * a redeploy; the backend is the cache layer, not this page. */
export const dynamic = "force-dynamic";

/** The platform rollup shape from `GET /clouds/stats`. Every figure is
 * `number | null` (null = not yet indexed). */
interface PlatformStats {
  poolCount: number | null;
  tvlUsd: number | null;
  volumeUsd: number | null;
  feesUsd: number | null;
  totalSwaps: number | null;
  activeTraders: number | null;
}

const EMPTY_STATS: PlatformStats = {
  poolCount: null,
  tvlUsd: null,
  volumeUsd: null,
  feesUsd: null,
  totalSwaps: null,
  activeTraders: null,
};

export default async function HomePage() {
  // Read both data sources in parallel; degrade to honest empties on failure.
  const [stats, pools] = await Promise.all([
    getStats().catch(() => EMPTY_STATS as PlatformStats),
    getPools({ sortBy: "tvl:desc", page: 1, pageSize: HOME_PAGE_SIZE })
      .then(
        (res: { pools?: PoolListItem[] } | null) =>
          (res?.pools ?? []) as PoolListItem[],
      )
      .catch(() => [] as PoolListItem[]),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-8 px-4 py-8 sm:px-6">
      {/* hero */}
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-pink/40 bg-pink/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-pink">
            Zero protocol fee at the AMM level
          </span>
          <h1 className="m-0 max-w-[18ch] text-[34px] font-semibold leading-[1.05] tracking-[-0.02em] text-fg sm:text-[44px]">
            Launch and trade {APP_NAME} markets.
          </h1>
          <p className="m-0 max-w-[60ch] text-[15px] leading-relaxed text-muted">
            {APP_NAME} is a bin-based DLMM AMM on Solana. Rain a new market in
            one signature, provide concentrated liquidity by bin, and trade it
            with the swap fee flowing to LPs and the creator, not to the AMM.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link
              href="/launch"
              className="inline-flex h-11 items-center justify-center rounded-md border border-pink/50 bg-pink px-5 text-[14px] font-semibold text-pink-fg no-underline transition-colors hover:bg-pink/90"
            >
              Rain a market
            </Link>
            <Link
              href="/explore"
              className="inline-flex h-11 items-center justify-center rounded-md border border-line bg-elevated px-5 text-[14px] font-medium text-fg no-underline transition-colors hover:border-pink/40 hover:text-pink"
            >
              Explore all pools
            </Link>
          </div>
        </div>

        {/* live platform KPIs; honest -- for any unindexed figure */}
        <StatBar stats={stats} />
      </section>

      {/* pool browser */}
      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="m-0 text-[18px] font-semibold tracking-[-0.01em] text-fg">
            Markets
          </h2>
          <Link
            href="/explore"
            className="text-[13px] text-muted no-underline transition-colors hover:text-pink"
          >
            View all &rarr;
          </Link>
        </div>
        <PoolList pools={pools} initialSortKey="tvl" initialSortDir="desc" />
      </section>
    </div>
  );
}
