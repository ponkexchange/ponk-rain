"use client";

/**
 * Persistent top navigation bar for `@ponkrain/launch`.
 *
 * Mounted once by the root layout above the routed page. It carries the brand
 * wordmark (a link home), the primary nav (Explore / Rain a market / Portfolio)
 * and the single app-wide wallet control ({@link WalletButton}).
 *
 * It is a client component because it reads the active route via
 * {@link usePathname} to mark the current nav item, and because the wallet
 * button is itself client-only. The bar is sticky so the connect control and
 * nav stay reachable while the page scrolls.
 *
 * Nav targets mirror the app's real routes: `/explore` (the full pool browser),
 * `/launch` (the create/"rain" flow) and `/portfolio` (the connected wallet's
 * positions). The brand mark links to `/` (the market home).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { BRAND_NAME } from "@/lib/config";
import { WalletButton } from "@/components/wallet/WalletButton";

/** A single primary nav destination. */
interface NavItem {
  /** Route the link points at. */
  href: string;
  /** Visible label. */
  label: string;
}

/**
 * The primary nav destinations, in display order. These map onto the app's
 * routes; the brand wordmark (rendered separately) is the home link.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { href: "/explore", label: "Explore" },
  { href: "/launch", label: "Rain a market" },
  { href: "/portfolio", label: "Portfolio" },
];

/**
 * Return whether `href` is the active route for the current `pathname`.
 *
 * The home route (`/`) matches only an exact pathname; every other route
 * matches its own path or any nested path under it (so `/pool/<addr>` keeps the
 * relevant top-level item highlighted where one applies).
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * App-wide sticky header: brand wordmark, primary nav, and the wallet connect
 * control. Takes no props; it is mounted once by the root layout.
 */
export function Header() {
  const pathname = usePathname() ?? "/";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 no-underline"
          aria-label={`${BRAND_NAME} home`}
        >
          <span
            aria-hidden
            className="h-5 w-5 rounded-full bg-pink shadow-[0_0_18px_2px_rgb(var(--pink)/0.45)]"
          />
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
            {BRAND_NAME}
          </span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "rounded-md px-3 py-1.5 text-[13px] font-medium no-underline transition-colors",
                  active
                    ? "bg-elevated text-fg"
                    : "text-muted hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
