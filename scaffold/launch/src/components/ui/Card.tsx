/**
 * Card primitive for the @ponkrain/launch scaffold.
 *
 * A bordered panel/section container used across the app (pool analytics,
 * swap widget, portfolio summary, the launch form). Self-contained so the
 * scaffold does not depend on the monorepo's shared `@ponk/ui` package.
 *
 * Styled with the design tokens from `tailwind.config.ts`: a `panel` surface,
 * a `line` border and the `card` radius. `elevated` swaps to the brighter
 * `elevated` surface for nested/raised cards (e.g. a card inside a card).
 * `interactive` adds a hover affordance for cards that are themselves links or
 * buttons.
 *
 * The companion `CardHeader`, `CardTitle` and `CardBody` parts give a
 * consistent header/title/content rhythm without forcing it; a card can also
 * be used as a plain container by passing children directly.
 */

import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import clsx from "clsx";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Use the brighter `elevated` surface (for cards nested inside cards). */
  elevated?: boolean;
  /** Add a hover border/lift affordance when the card wraps a link/button. */
  interactive?: boolean;
}

/**
 * Bordered container. Defaults to no inner padding so callers can compose
 * `CardHeader` / `CardBody` (which carry their own padding) or apply their own
 * padding utility; this keeps the card usable for both padded sections and
 * full-bleed content like charts and tables.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { elevated, interactive, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        "rounded-card border border-line",
        elevated ? "bg-elevated" : "bg-panel",
        interactive && "transition-colors hover:border-pink/40",
        className,
      )}
      {...rest}
    />
  );
});

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional right-aligned slot (e.g. a filter control or a link). */
  action?: ReactNode;
}

/**
 * Header row for a card: padded, separated from the body by a hairline, and
 * laid out as title (children) on the left with an optional `action` slot on
 * the right.
 */
export function CardHeader({
  action,
  className,
  children,
  ...rest
}: CardHeaderProps) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-3 border-b border-line px-4 py-3",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0">{children}</div>
      {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Card title text. Renders as a heading-weight label inside a `CardHeader`. */
export function CardTitle({
  className,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={clsx("truncate text-[14px] font-semibold text-fg", className)}
      {...rest}
    />
  );
}

/** Padded content region of a card. */
export function CardBody({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("p-4", className)} {...rest} />;
}
