"use client";

/**
 * Client provider boundary for the app.
 *
 * The root layout (layout.tsx) is a server component, so every context that
 * needs the browser - the Solana wallet adapter stack and TanStack Query -
 * is composed here behind a single "use client" boundary and mounted once.
 *
 * Order matters: the wallet stack ({@link WalletProvider}, which itself nests
 * ConnectionProvider -> WalletProvider -> WalletModalProvider) wraps the React
 * Query provider so any query/mutation hook can read the connected wallet and
 * connection. Children (the whole app tree) sit innermost.
 *
 * The QueryClient is created once per browser session via useState's lazy
 * initializer (not at module scope) so each request gets a fresh client during
 * SSR and the client is not shared across users, while staying stable across
 * re-renders on the client.
 */

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "@/components/wallet/WalletProvider";

/**
 * Compose the app-wide client providers.
 *
 * @param children - the application tree (Header, page, Footer) the server
 *   layout passes through.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Market data (pools, swaps, stats) is mildly volatile; a short
            // stale window avoids refetch storms on navigation while keeping
            // figures fresh. Live price/last-trade ticks come from the SSE
            // feed (useCloudsFeed), not query polling, so we do not aggressively
            // refetch on focus.
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WalletProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WalletProvider>
  );
}
