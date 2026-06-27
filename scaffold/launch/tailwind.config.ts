import type { Config } from "tailwindcss";

/**
 * Tailwind configuration for the @ponkrain/launch scaffold.
 *
 * The color palette is wired to CSS custom properties defined in
 * `src/app/globals.css` (`--bg`, `--panel`, `--line`, `--fg`, `--muted`,
 * `--pink`, ...) so the same token names work in both Tailwind utility
 * classes (`bg-bg`, `border-line`, `text-pink`) and raw CSS. This keeps the
 * design tokens in one place and lets components reference them by name.
 *
 * `pink` is the Ponk brand accent. The numeric scale entries map to the same
 * variable with baked-in alpha so faint surfaces (`bg-pink/10` style needs)
 * can be expressed as explicit tokens where alpha-via-slash is awkward.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        pink: "rgb(var(--pink) / <alpha-value>)",
        "pink-fg": "rgb(var(--pink-fg) / <alpha-value>)",
        positive: "rgb(var(--positive) / <alpha-value>)",
        negative: "rgb(var(--negative) / <alpha-value>)",
      },
      borderRadius: {
        card: "0.875rem",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
