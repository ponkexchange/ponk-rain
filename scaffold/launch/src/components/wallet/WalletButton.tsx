"use client";

/**
 * The single wallet connect / account control for the launch app.
 *
 * This is a thin wrapper around the wallet-adapter {@link WalletMultiButton}: it
 * is the one connect entry point the whole app mounts (header, the /portfolio and
 * /pool connect prompts, and the LaunchForm submit gate). Pre-connect it shows
 * "Select Wallet" and opens the adapter's wallet-choice modal; once connected it
 * shows the truncated address with the disconnect / change-wallet menu. All of
 * its styling (the brand-pink trigger and the re-skinned dark modal) lives in
 * globals.css against the `.wallet-adapter-*` classes, so this component adds no
 * styles of its own.
 *
 * It relies on the {@link WalletModalProvider} that {@link Providers} mounts
 * (ConnectionProvider -> WalletProvider -> WalletModalProvider), so the button
 * can open the connect modal from anywhere in the tree.
 *
 * SSR note: `WalletMultiButton` reads the wallet adapter state, which `autoConnect`
 * (and wallet-standard auto-registration) can populate synchronously on the first
 * client render, before this mounts. The server always renders the disconnected
 * label, so we gate the real button behind a post-mount flag and render a stable,
 * non-interactive placeholder with identical dimensions first. This keeps the
 * first client render identical to the server's and avoids a hydration mismatch.
 */

import { useEffect, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

/**
 * `true` after the component has mounted on the client.
 *
 * Used to defer rendering the wallet-adapter button (whose label depends on
 * client-only adapter state) until after hydration, so the first client render
 * matches the server-rendered markup.
 */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * The app-wide wallet connect / account button.
 *
 * Renders the wallet-adapter {@link WalletMultiButton} (skinned by globals.css).
 * Takes no props: every call site mounts it as `<WalletButton />`, the single
 * connect control for the app.
 */
export function WalletButton() {
  const mounted = useMounted();

  // Before hydration we cannot know the connected state, so render a stable,
  // non-interactive stand-in styled exactly like the connect trigger. It carries
  // the real button's label so layout does not shift when the live button mounts.
  if (!mounted) {
    return (
      <button
        type="button"
        className="wallet-adapter-button wallet-adapter-button-trigger"
        disabled
        aria-hidden
      >
        Select Wallet
      </button>
    );
  }

  return <WalletMultiButton />;
}
