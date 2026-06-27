/**
 * PostCSS configuration for the @ponkrain/launch scaffold.
 *
 * Tailwind v3 + autoprefixer, the classic pairing. (The dex app uses the v4
 * `@tailwindcss/postcss` pipeline; this scaffold pins v3 per its dependency
 * set so `tailwind.config.ts` content/theme is honored.)
 */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
