import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Next.js configuration for the @ponkrain/launch scaffold.
 *
 * The app is a clone-and-run launchpad for the Ponk Clouds DLMM AMM. A few
 * choices worth calling out:
 *
 *   - `transpilePackages: ["@ponkrain/sdk"]` so the monorepo SDK can be
 *     consumed directly from its TypeScript/ESM source during local dev
 *     without a separate prebuild step, and is bundled into the app build.
 *
 *   - `output: "standalone"` plus `outputFileTracingRoot` pointed at the
 *     ponk-rain repo root so the workspace SDK is traced into the standalone
 *     server bundle for self-contained deployment (Docker / a bare VM).
 *
 *   - `images.remotePatterns` is intentionally permissive over https only.
 *     Token logos are user-supplied (uploaded via /api/token/metadata or an
 *     external registry), so we cannot enumerate hosts ahead of time. The
 *     TokenIcon component still falls back to a generated monogram when an
 *     image fails to load, so a bad URL never renders a broken image.
 *
 * No remote rewrites/redirects are configured here: cross-origin reads to the
 * backend go through the same-origin `/api/*` proxy routes, and the SSE feed
 * connects to NEXT_PUBLIC_API_URL directly from the browser.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ponkrain/sdk"],
  output: "standalone",
  // Next 14 places file-tracing root under `experimental`; pointed at the
  // ponk-rain repo root so the workspace SDK is traced into the standalone
  // server bundle for self-contained deployment.
  experimental: {
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  webpack: (config) => {
    // Optional pretty-logger / storage deps referenced transitively by some
    // wallet-adapter and storage internals; they are never used in the
    // browser bundle, so stub them out to keep the build clean.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
