import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

/**
 * Root layout for @ponkrain/launch.
 *
 * The single mount point for app-wide concerns:
 *   - the global Tailwind stylesheet + design tokens (globals.css),
 *   - the two web fonts, exposed as the `--font-sans` / `--font-mono` CSS
 *     variables that tailwind.config.ts's fontFamily and globals.css read,
 *   - the client provider stack ({@link Providers}: the Solana wallet adapter
 *     ConnectionProvider/WalletProvider/WalletModalProvider plus a TanStack
 *     QueryClientProvider),
 *   - the persistent {@link Header} (nav + connect button) and {@link Footer}
 *     (honesty disclaimer + assessment link + program id).
 *
 * This file is a server component; all browser-only context lives behind the
 * "use client" boundary in providers.tsx so the layout itself stays static and
 * streamable.
 */

// Self-hosted, swap-displayed web fonts. next/font inlines them and assigns a
// stable CSS variable per font; we bind those to the token names the theme and
// raw CSS reference, so swapping the typeface is a one-line change here.
const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "Ponk Rain - Launch a Ponk Clouds DLMM",
    template: "%s · Ponk Rain",
  },
  description:
    "Launch, trade, and provide liquidity on Ponk Clouds, a non-custodial bin-based DLMM AMM on Solana with zero protocol fee at the AMM level.",
  applicationName: "Ponk Rain",
  openGraph: {
    type: "website",
    siteName: "Ponk Rain",
    title: "Ponk Rain - Launch a Ponk Clouds DLMM",
    description:
      "Non-custodial bin-based DLMM AMM on Solana. Zero protocol fee at the AMM level - LPs and creators keep the swap fee.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Ponk Rain - Launch a Ponk Clouds DLMM",
    description:
      "Non-custodial bin-based DLMM AMM on Solana with zero protocol fee at the AMM level.",
  },
};

// Render at device width (not zoomed-out desktop) on phones; allow pinch-zoom
// for accessibility. themeColor matches the --bg canvas so the mobile browser
// chrome blends into the app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#07070a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-bg text-fg antialiased">
        <Providers>
          {/* Sticky header, scrolling content, footer pinned below content.
              flex column so the footer sits at the bottom on short pages. */}
          <div className="flex min-h-screen flex-col">
            <Header />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}
