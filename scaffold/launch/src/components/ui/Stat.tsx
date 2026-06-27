/**
 * Stat primitive for the @ponkrain/launch scaffold: a label + value pair.
 *
 * This is the leaf where the no-fabrication rule is enforced. When `value` is
 * `null` or `undefined` it renders the shared `--` dash instead of inventing a
 * number, so every metric in the StatBar / PoolAnalytics / PortfolioSummary
 * that the indexer has not yet computed reads honestly. A formatted string
 * (e.g. `"$1.2M"`, `"4.0 bps"`) or any node passes straight through.
 *
 * `tone` colors the value for deltas (PnL, price moves): `positive` /
 * `negative` use the semantic tokens; `muted` quiets context values. The dash
 * is always rendered muted regardless of `tone`, since a missing value has no
 * sign.
 *
 * `align` lets a stat sit left (default, in a vertical list) or right (in a KPI
 * strip column). `size` scales the value type for hero vs inline use.
 */

import type { ReactNode } from "react";
import clsx from "clsx";

/** The honest placeholder rendered for any null/undefined value. */
export const EMPTY_VALUE = "--" as const;

/** Color treatment of the value. */
export type StatTone = "default" | "positive" | "negative" | "muted";

/** Type scale of the value. */
export type StatSize = "sm" | "md" | "lg";

export interface StatProps {
  /** Metric label, e.g. `"24h volume"`. */
  label: ReactNode;
  /**
   * Pre-formatted value (string/number/node). `null` or `undefined` renders
   * the `--` dash; never fabricated. Pass an empty string only if you really
   * mean an empty value (it will also dash).
   */
  value: ReactNode;
  /** Optional secondary line under the value (e.g. a `%` delta or sub-label). */
  sub?: ReactNode;
  /** Color treatment of the value. */
  tone?: StatTone;
  /** Value type scale. */
  size?: StatSize;
  /** Horizontal alignment of the label + value column. */
  align?: "left" | "right";
  /** Extra classes for the wrapper. */
  className?: string;
}

const toneClass: Record<StatTone, string> = {
  default: "text-fg",
  positive: "text-positive",
  negative: "text-negative",
  muted: "text-muted",
};

const sizeClass: Record<StatSize, string> = {
  sm: "text-[13px]",
  md: "text-[15px]",
  lg: "text-[22px]",
};

/**
 * True when the value should render as the `--` dash: `null`, `undefined`, or
 * an empty/whitespace-only string. Numbers (including `0`) and other nodes are
 * real values and pass through.
 */
function isEmpty(value: ReactNode): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

/**
 * Render one labelled metric. The value uses tabular monospace figures so
 * columns of money line up, and dashes when the underlying metric is absent.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "default",
  size = "md",
  align = "left",
  className,
}: StatProps) {
  const empty = isEmpty(value);

  return (
    <div
      className={clsx(
        "flex flex-col gap-0.5",
        align === "right" ? "items-end text-right" : "items-start text-left",
        className,
      )}
    >
      <span className="text-[11px] uppercase tracking-[0.04em] text-muted">
        {label}
      </span>
      <span
        className={clsx(
          "font-mono font-semibold tabular-nums",
          sizeClass[size],
          empty ? "text-muted" : toneClass[tone],
        )}
      >
        {empty ? EMPTY_VALUE : value}
      </span>
      {sub ? (
        <span className="text-[11px] font-mono tabular-nums text-muted">
          {sub}
        </span>
      ) : null}
    </div>
  );
}
