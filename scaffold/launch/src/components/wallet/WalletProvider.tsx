"use client";

/**
 * The Solana wallet-adapter stack for `@ponkrain/launch`, exposed as a single
 * {@link WalletProvider} component.
 *
 * It nests the three adapter contexts the rest of the app relies on, in order:
 *
 *   ConnectionProvider -> (adapter) WalletProvider -> WalletModalProvider
 *
 *   - {@link ConnectionProvider} binds the app to one RPC, {@link CLOUDS_RPC_ENDPOINT}
 *     (the same endpoint {@link ponkCloudsConnection} builds its imperative
 *     {@link Connection} from), so the wallet-adapter `useConnection()` and the
 *     SDK/tx-building path always agree on one cluster.
 *   - the adapter {@link AdapterWalletProvider} tracks the connected wallet and
 *     signing; `autoConnect` reconnects the last-used wallet on load.
 *   - {@link WalletModalProvider} supplies the connect-modal context that
 *     {@link WalletButton}'s `WalletMultiButton` opens from anywhere in the tree.
 *
 * The component name intentionally shadows the adapter's `WalletProvider`: this
 * is the one wallet boundary the app's {@link Providers} mounts, so callers
 * import a single `WalletProvider` and get the whole stack.
 *
 * The modal's stylesheet (`@solana/wallet-adapter-react-ui/styles.css`) is
 * imported once in globals.css, so this component adds no styles of its own.
 */

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider as AdapterWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import { CLOUDS_RPC_ENDPOINT } from "@/lib/connection";

/**
 * Mount the app-wide Solana wallet stack.
 *
 * @param children - the tree (the TanStack Query provider and the whole app)
 *   that needs `useConnection()` / `useWallet()` and the connect modal.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  // Phantom, Solflare, Backpack and other modern wallets auto-register via the
  // Wallet Standard, so the provider discovers them with no explicit adapters.
  // Newing up adapters here would be redundant and makes those wallets log the
  // "registered as a Standard Wallet ... can be removed from your app" warning.
  // Keep this an empty, stable reference so the wallet set is never
  // re-registered on re-render.
  const wallets = useMemo<Adapter[]>(() => [], []);

  return (
    <ConnectionProvider endpoint={CLOUDS_RPC_ENDPOINT}>
      <AdapterWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </AdapterWalletProvider>
    </ConnectionProvider>
  );
}
