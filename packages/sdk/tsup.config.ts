import { defineConfig } from "tsup";

/**
 * Build config for @ponkrain/sdk.
 *
 * Emits dual ESM (`dist/index.js`) and CommonJS (`dist/index.cjs`) bundles
 * from the single `src/index.ts` barrel, plus `.d.ts` type declarations, so
 * the SDK works for both modern ESM consumers (the @ponkrain/launch scaffold,
 * Next.js apps) and legacy CJS toolchains.
 *
 * @solana/web3.js is left external: it is a peer-ish runtime dependency that
 * apps already install, and bundling it would bloat the SDK and risk duplicate
 * PublicKey/Connection class identities across the dependency graph.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  target: "es2022",
  platform: "neutral",
  external: ["@solana/web3.js"],
});
