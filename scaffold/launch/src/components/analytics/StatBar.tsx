/**
 * StatBar - the live platform KPI strip on the Ponk Rain home / explore hero.
 *
 * A pure presentational strip driven by the platform rollup from
 * `GET /clouds/stats` ({@link PlatformStats}). It renders pool count, TVL, 24h
 * volume, 24h fees, total swaps, and active traders as a responsive row of
 * {@link Stat} cells.
 *
 * HONESTY (the no-fabrication rule): every figure is `number | null`. A `null`
 * (the indexer has not computed that metric yet, or no backend is running)
 * renders as the shared `--` dash via the leaf {@link Stat} primitive; a real
 * `0` is shown as `0`. Nothing is estimated or back-filled. When the whole
 * rollup is empty (a fresh clone with no indexer) the strip still renders, every
 * cell dashed, rather than disappearing or showing fake numbers.
 *
 * This component holds no state and opens no connection; the page (a server
 * component) fetches the rollup and passes it in, so the strip is reusable on
 * any surface that already has a {@link PlatformStats}.
 */

import { Stat } from "@/components/ui/Stat";
import { formatUsdCompact, formatNumberCompact } from "@/lib/format";
import type { PlatformStats } from "@/lib/api";

export interface StatBarProps {
  /** The platform rollup. Any field may be `null` (rendered as `--`). */
  stats: PlatformStats;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * Render the platform KPI strip. Money figures use the compact USD formatter
 * (`$1.2M`), counts use the compact number formatter (`1.2M`); both render `--`
 * for a `null` input. A real `0` passes through as `0`, never dashed.
 */
export function StatBar({ stats, className }: StatBarProps) {
  return (
    <div
      className={
        "grid grid-cols-2 gap-x-4 gap-y-4 rounded-card border border-line bg-panel p-4 sm:grid-cols-3 lg:grid-cols-6" +
        (className ? ` ${className}` : "")
      }
    >
      <Stat label="Pools" value={formatNumberCompact(stats.poolCount)} size="lg" />
      <Stat label="TVL" value={formatUsdCompact(stats.tvlUsd)} size="lg" />
      <Stat label="24h volume" value={formatUsdCompact(stats.volumeUsd)} size="lg" />
      <Stat label="24h fees" value={formatUsdCompact(stats.feesUsd)} size="lg" />
      <Stat label="Total swaps" value={formatNumberCompact(stats.totalSwaps)} size="lg" />
      <Stat label="Active traders" value={formatNumberCompact(stats.activeTraders)} size="lg" />
    </div>
  );
}
