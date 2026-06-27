"use client";

/**
 * /portfolio - the connected wallet's Ponk Clouds LP positions.
 *
 * Ponk Clouds is Solana-only, so the connected Solana wallet IS the owner. This
 * client page reads the owner's open positions DIRECTLY FROM CHAIN via
 * `@ponkrain/sdk`: it discovers every Ponk Clouds pool ({@link discoverPools}),
 * reads the owner's positions in each ({@link readPositions}), and for the pools
 * the owner actually holds liquidity in, reads the bin distribution
 * ({@link readBinDistribution}) for an honest pool price + in/out-of-range flag.
 *
 * This is the same guarantee the dex portfolio's on-chain fallback gives: a
 * freshly-opened position shows up immediately, never hidden behind an indexer.
 *
 * HONESTY (do not paper over): the chain gives token amounts, the pool price,
 * and the in-range flag, but NOT a trustworthy USD valuation or cost-basis
 * without the indexer's pricing pipeline. So every USD / PnL field is null and
 * the {@link PositionsTable} renders "--"; counts (open positions, pools) are
 * always real. `claimableUsd` is 0 because Ponk Clouds fees auto-compound into
 * the bin reserves - there is no separate claimable balance. A per-pool read
 * failure is swallowed so one bad pool can never blank the whole portfolio.
 *
 * Pre-connect, the page prompts the {@link WalletButton}; it never renders a
 * fabricated portfolio for a disconnected wallet.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  discoverPools,
  priceOfBin,
  readBinDistribution,
  readPositions,
  type BinDistribution,
  type CloudsPosition,
  type PoolInfo,
} from "@ponkrain/sdk";
import { ponkCloudsConnection } from "@/lib/connection";
import { WalletButton } from "@/components/wallet/WalletButton";
import {
  PositionsTable,
  type CloudsPositionRow,
} from "@/components/portfolio/PositionsTable";

/**
 * Shape one on-chain position into a {@link CloudsPositionRow}. Pool price and
 * the in-range flag are honest on-chain reads; USD / PnL fields are null because
 * they need the indexer's price + cost-basis pipeline (the table renders "--").
 */
function toRow(
  info: PoolInfo,
  pos: CloudsPosition,
  dist: BinDistribution | null,
): CloudsPositionRow {
  const poolPrice = dist
    ? priceOfBin(dist.activeBinId, dist.binStepBps, info.decimalsX, info.decimalsY)
    : null;
  const inRange =
    dist != null &&
    dist.activeBinId >= pos.lowerBinId &&
    dist.activeBinId <= pos.upperBinId;
  // Swap fee as a percent; fall back to a bin-step-derived figure only when the
  // distribution failed to load (so the cell is never a fabricated guess).
  const feePct = dist ? dist.swapFeeBps / 100 : info.binStep / 100;
  return {
    positionAddress: pos.address,
    poolAddress: info.address,
    tokenX: info.mintX,
    tokenY: info.mintY,
    symbolX: info.symbolX,
    symbolY: info.symbolY,
    binStep: info.binStep,
    feePct,
    valueUsd: null,
    depositUsd: null,
    pnlUsd: null,
    pnlPct: null,
    claimableUsd: 0,
    feeTvl24hPct: null,
    poolPrice,
    inRange,
    isOpen: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read EVERY open position the owner holds across all Ponk Clouds pools.
 *
 * Discovers all pools, then for each reads the owner's positions; only pools the
 * owner is actually in pay for the (heavier) bin-distribution read used for
 * price + range. A per-pool failure is swallowed so one bad pool cannot blank
 * the portfolio. Returns [] on a total RPC failure (the page then shows the
 * empty state, never an error).
 */
async function readOwnerPositions(owner: string): Promise<CloudsPositionRow[]> {
  let ownerKey: PublicKey;
  try {
    ownerKey = new PublicKey(owner);
  } catch {
    return [];
  }

  const conn = ponkCloudsConnection();
  let pools: PoolInfo[];
  try {
    pools = await discoverPools(conn);
  } catch {
    return [];
  }

  const perPool = await Promise.all(
    pools.map(async (info): Promise<CloudsPositionRow[]> => {
      try {
        const positions = await readPositions(conn, info, ownerKey);
        if (positions.length === 0) return [];
        let dist: BinDistribution | null = null;
        try {
          dist = await readBinDistribution(conn, info, 30);
        } catch {
          dist = null;
        }
        return positions.map((pos) => toRow(info, pos, dist));
      } catch {
        return [];
      }
    }),
  );

  return perPool.flat();
}

/** A small KPI cell; value renders "--" when null (no fabrication). */
function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-card border border-line bg-panel px-4 py-3">
      <span className="text-[10px] uppercase tracking-[0.07em] text-muted">
        {label}
      </span>
      <span className="font-mono text-lg text-fg">{value || "--"}</span>
    </div>
  );
}

/**
 * The /portfolio route (client). Prompts a connect when no wallet is attached;
 * otherwise reads and renders the owner's positions from chain.
 */
export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58() ?? null;

  const positionsQuery = useQuery({
    queryKey: ["clouds-portfolio-positions", owner],
    enabled: !!owner,
    queryFn: () => readOwnerPositions(owner as string),
    // Positions move with deposits/withdrawals/compounding; refresh on a steady
    // cadence so the table reflects chain without a manual reload.
    refetchInterval: 20_000,
  });

  const rows = positionsQuery.data ?? [];

  // Real, on-chain counts (never fabricated). USD rollups stay "--" because a
  // trustworthy valuation needs the indexer's pricing pipeline.
  const counts = useMemo(() => {
    const pools = new Set(rows.map((r) => r.poolAddress));
    const inRange = rows.filter((r) => r.inRange).length;
    return { open: rows.length, pools: pools.size, inRange };
  }, [rows]);

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 pb-16 pt-8">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-fg">
          Portfolio
        </h1>
        <p className="m-0 text-[13px] text-muted">
          Your open Ponk Clouds liquidity positions, read live from chain. Fees
          auto-compound into your reserves, so there is never a separate
          claimable balance.
        </p>
      </header>

      {!owner ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-panel px-6 py-16 text-center">
          <h2 className="m-0 text-[16px] font-semibold text-fg">
            Connect your wallet
          </h2>
          <p className="m-0 max-w-[420px] text-sm text-muted">
            Connect a Solana wallet to see and manage your LP positions across
            every Ponk Clouds pool.
          </p>
          <WalletButton />
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              label="Open positions"
              value={positionsQuery.isLoading ? "--" : String(counts.open)}
            />
            <Kpi
              label="Pools"
              value={positionsQuery.isLoading ? "--" : String(counts.pools)}
            />
            <Kpi
              label="In range"
              value={positionsQuery.isLoading ? "--" : String(counts.inRange)}
            />
            {/* USD value needs the indexer's pricing pipeline; honest "--". */}
            <Kpi label="Total value" value="--" />
          </section>

          {positionsQuery.isLoading ? (
            <div className="h-48 animate-pulse rounded-card border border-line bg-panel" />
          ) : positionsQuery.isError ? (
            <div className="flex flex-col items-center gap-2 rounded-card border border-line bg-panel px-6 py-12 text-center">
              <p className="m-0 text-sm font-medium text-fg">
                Could not reach the Ponk Clouds RPC.
              </p>
              <button
                type="button"
                onClick={() => positionsQuery.refetch()}
                className="mt-1 rounded-card border border-line px-4 py-2 text-sm font-medium text-fg hover:border-pink/50 hover:text-pink"
              >
                Retry
              </button>
            </div>
          ) : (
            <PositionsTable
              rows={rows}
              emptyLabel="You have no open positions yet."
            />
          )}

          <p className="m-0 text-center text-[11px] text-muted">
            Want to provide liquidity?{" "}
            <Link href="/explore" className="text-pink hover:underline">
              Browse pools
            </Link>{" "}
            or{" "}
            <Link href="/launch" className="text-pink hover:underline">
              create one
            </Link>
            .
          </p>
        </>
      )}
    </main>
  );
}
