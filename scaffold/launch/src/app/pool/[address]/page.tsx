"use client";

/**
 * /pool/[address] - Ponk Clouds pool detail + liquidity.
 *
 * The pool's identity is its PDA address (base58) in the route. This page reads
 * everything it shows DIRECTLY FROM CHAIN via `@ponkrain/sdk`, so a pool created
 * seconds ago through /launch appears immediately without waiting on any indexer:
 *
 *  - {@link readPoolInfoOnChain} resolves the pair's mints, decimals, symbols
 *    (honest short-mint fallback) and bin step. A missing/foreign account 404s
 *    honestly ("Pool not found") rather than rendering a fake pool.
 *  - {@link readBinDistribution} gives the active bin, fee parameters, and the
 *    per-bin reserves around the active price (the bin book for the chart and the
 *    pool price).
 *  - {@link readPositions} reads the CONNECTED owner's positions in this pool;
 *    {@link positionRange} + {@link valuePosition} derive each one's range and
 *    in/out-of-range flag, which feed the shared {@link PositionsTable}.
 *
 * HONESTY: the active price, fee tier, bin reserves, and per-position range come
 * straight from the program. USD valuations are intentionally null here (they
 * need the indexer's price + cost-basis pipeline), so every dollar field renders
 * a plain "--" rather than a fabricated number. `?action=add` from /launch
 * scrolls the liquidity section into view.
 *
 * This page owns the route, the on-chain reads, the pool header / fee summary,
 * and the owner-positions section. The dedicated liquidity-chart, analytics, and
 * add/remove panels (their own modules) mount alongside; the page stands up and
 * is fully honest without them.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  priceOfBin,
  readBinDistribution,
  readPoolInfoOnChain,
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

/** Short mint / address label `Xxxx..Xxxx`; honest, never fabricated. */
function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}..${addr.slice(-4)}` : addr;
}

/** Pool price (quote per base): adaptive precision; "--" when null. */
function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v === 0) return "0";
  return v.toPrecision(4);
}

/** Plain percent; "--" when null. */
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  return `${v.toFixed(2)}%`;
}

/** A label + value pair; value renders "--" when null/empty (no fabrication). */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.07em] text-muted">
        {label}
      </span>
      <span className="font-mono text-sm text-fg">{value || "--"}</span>
    </div>
  );
}

/**
 * The combined on-chain read for a pool: its display info plus its bin
 * distribution. Both come from the SDK; the caller renders honest "--" for any
 * value the chain does not provide.
 */
interface PoolView {
  info: PoolInfo;
  dist: BinDistribution;
}

/**
 * Read the pool's display metadata and bin distribution from chain. Returns null
 * when no Ponk Clouds pool exists at this address (so the page 404s honestly).
 */
async function loadPool(address: string): Promise<PoolView | null> {
  const conn = ponkCloudsConnection();
  const info = await readPoolInfoOnChain(conn, address);
  if (!info) return null;
  const dist = await readBinDistribution(conn, info, 30);
  return { info, dist };
}

/**
 * Shape one on-chain position into a {@link CloudsPositionRow}. The pool price
 * and in-range flag are honest on-chain reads; USD / PnL fields are null because
 * they require the indexer's price + cost-basis pipeline (the table renders
 * "--"). `claimableUsd` is 0 because Ponk Clouds fees auto-compound.
 */
function toRow(view: PoolView, pos: CloudsPosition): CloudsPositionRow {
  const { info, dist } = view;
  const poolPrice = priceOfBin(
    dist.activeBinId,
    dist.binStepBps,
    info.decimalsX,
    info.decimalsY,
  );
  const inRange =
    dist.activeBinId >= pos.lowerBinId && dist.activeBinId <= pos.upperBinId;
  return {
    positionAddress: pos.address,
    poolAddress: info.address,
    tokenX: info.mintX,
    tokenY: info.mintY,
    symbolX: info.symbolX,
    symbolY: info.symbolY,
    binStep: info.binStep,
    feePct: dist.swapFeeBps / 100,
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
 * The /pool/[address] route (client). Reads the pool and the connected owner's
 * positions on chain, honoring the `?action=add` deep link by scrolling the
 * liquidity section into view once the pool resolves.
 */
export default function PoolPage({
  params,
}: {
  params: { address: string };
}) {
  const address = params.address;
  const search = useSearchParams();
  const focusAdd = search.get("action") === "add";
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58() ?? null;
  const liquidityRef = useRef<HTMLDivElement | null>(null);

  // Validate the address up front so a garbage route fails fast and honestly.
  const validAddress = useMemo(() => {
    try {
      // eslint-disable-next-line no-new
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }, [address]);

  const poolQuery = useQuery({
    queryKey: ["clouds-pool", address],
    queryFn: () => loadPool(address),
    enabled: validAddress,
    // The bin book and active price move with trades; a short window keeps the
    // page fresh without hammering the RPC on every navigation.
    refetchInterval: 15_000,
  });

  const view = poolQuery.data ?? null;

  const positionsQuery = useQuery({
    queryKey: ["clouds-pool-positions", address, owner],
    enabled: validAddress && !!owner && !!view,
    queryFn: async (): Promise<CloudsPositionRow[]> => {
      if (!owner || !view) return [];
      const conn = ponkCloudsConnection();
      const positions = await readPositions(
        conn,
        view.info,
        new PublicKey(owner),
      );
      return positions.map((p) => toRow(view, p));
    },
    refetchInterval: 15_000,
  });

  // Honor the ?action=add deep link from /launch: scroll the liquidity section
  // into view once the pool has resolved (and the section exists in the DOM).
  useEffect(() => {
    if (focusAdd && view && liquidityRef.current) {
      liquidityRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusAdd, view]);

  if (!validAddress) {
    return <NotFound address={address} reason="That is not a valid pool address." />;
  }

  if (poolQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-20 animate-pulse rounded-card border border-line bg-panel" />
        <div className="h-64 animate-pulse rounded-card border border-line bg-panel" />
      </div>
    );
  }

  if (poolQuery.isError) {
    return (
      <NotFound
        address={address}
        reason="Could not reach the Ponk Clouds RPC to read this pool. Try again."
      />
    );
  }

  if (!view) {
    return <NotFound address={address} reason="No Ponk Clouds pool exists at this address." />;
  }

  const { info, dist } = view;
  const activePrice = priceOfBin(
    dist.activeBinId,
    dist.binStepBps,
    info.decimalsX,
    info.decimalsY,
  );
  // Protocol fee is a share OF the swap fee (zero at the AMM level), so a
  // protocol cut only exists when the creator set one. Render it honestly.
  const swapFeePct = dist.swapFeeBps / 100;
  const protocolPctOfTrade =
    dist.protocolFeeBps > 0
      ? (dist.swapFeeBps * dist.protocolFeeBps) / 10_000 / 100
      : 0;

  const rows = positionsQuery.data ?? [];

  return (
    <>
      <header className="flex flex-col gap-4 rounded-card border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[20px] font-semibold tracking-[-0.02em] text-fg">
              {info.symbolX} / {info.symbolY}
            </h1>
            <a
              href={`https://solscan.io/account/${info.address}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-muted hover:text-pink"
            >
              {shortAddr(info.address)}
            </a>
          </div>
          <span className="rounded-full border border-pink/40 bg-pink/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-pink">
            Zero protocol fee
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Active price" value={fmtPrice(activePrice)} />
          <Stat label="Bin step" value={`${info.binStep} bps`} />
          <Stat label="Swap fee" value={fmtPct(swapFeePct)} />
          <Stat
            label="Creator fee"
            value={protocolPctOfTrade > 0 ? fmtPct(protocolPctOfTrade) : "0%"}
          />
        </div>
      </header>

      <section className="flex flex-wrap items-center gap-3">
        <Link
          href={`/trade/${info.address}`}
          className="rounded-card border border-line px-4 py-2 text-sm font-medium text-fg hover:border-pink/50 hover:text-pink"
        >
          Trade
        </Link>
        <Link
          href={`/pool/${info.address}?action=add`}
          className="rounded-card bg-pink px-4 py-2 text-sm font-semibold text-pink-fg hover:opacity-90"
        >
          Add liquidity
        </Link>
      </section>

      <section ref={liquidityRef} className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-[15px] font-semibold text-fg">Your liquidity</h2>
          {owner ? (
            <span className="font-mono text-[11px] text-muted">
              {shortAddr(owner)}
            </span>
          ) : null}
        </div>

        {!owner ? (
          <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-panel px-6 py-10 text-center">
            <p className="m-0 text-sm text-muted">
              Connect a wallet to see and manage your positions in this pool.
            </p>
            <WalletButton />
          </div>
        ) : positionsQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-card border border-line bg-panel" />
        ) : (
          <PositionsTable
            rows={rows}
            emptyLabel="You have no liquidity in this pool yet."
          />
        )}
      </section>
    </>
  );
}

/**
 * Honest 404 panel for a pool that does not exist (bad address, no account, or
 * an RPC failure). Never renders a fabricated pool.
 */
function NotFound({ address, reason }: { address: string; reason: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-panel px-6 py-16 text-center">
      <h1 className="m-0 text-[18px] font-semibold text-fg">Pool not found</h1>
      <p className="m-0 max-w-[420px] text-sm text-muted">{reason}</p>
      <p className="m-0 font-mono text-[11px] text-muted">{shortAddr(address)}</p>
      <Link
        href="/explore"
        className="mt-2 rounded-card border border-line px-4 py-2 text-sm font-medium text-fg hover:border-pink/50 hover:text-pink"
      >
        Browse pools
      </Link>
    </div>
  );
}
