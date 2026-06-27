/**
 * Button primitive for the @ponkrain/launch scaffold.
 *
 * The one button the app's interactive surfaces use (the LaunchForm submit, the
 * SwapWidget submit, and any future call-to-action). Self-contained so the
 * scaffold does not depend on the monorepo's shared `@ponk/ui` package, and
 * styled with the design tokens from `tailwind.config.ts` (the brand `pink`
 * accent, the `line` border, the `elevated` surface, the `card` radius).
 *
 * Variants:
 *   - `primary`   the brand-pink call to action (create pool, swap).
 *   - `secondary` a bordered, neutral-surface button for lower-emphasis actions.
 *   - `ghost`     a borderless text button for tertiary actions.
 *   - `danger`    a destructive action, tinted with the `negative` token.
 *
 * Sizes `sm` / `md` / `lg` set the height + horizontal padding + text size.
 * `disabled` (or `loading`) dims the button and blocks the click; `loading`
 * additionally swaps the leading content for a spinner so a submit-in-flight
 * state is honest about being busy rather than silently inert.
 *
 * This component renders a real `<button>`; it never fabricates a disabled
 * "coming soon" control. A caller that has nothing to wire should not render it.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import clsx from "clsx";

/** The visual emphasis of the button. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** The button's size, controlling height, padding, and text size. */
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual emphasis (default `primary`). */
  variant?: ButtonVariant;
  /** Size (default `md`). */
  size?: ButtonSize;
  /**
   * Show a spinner in place of the leading content and block the click. Use
   * while a submit is in flight; the button stays disabled for the duration.
   */
  loading?: boolean;
  /** Optional leading icon/adornment (hidden while `loading`). */
  leading?: ReactNode;
  /** Optional trailing icon/adornment. */
  trailing?: ReactNode;
}

/** Variant -> class map. Kept as a lookup so the variants stay declarative. */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-pink text-pink-fg hover:bg-pink/90 focus-visible:ring-pink/60 disabled:bg-pink/40",
  secondary:
    "border border-line bg-elevated text-fg hover:border-pink/50 focus-visible:ring-pink/40",
  ghost:
    "bg-transparent text-fg hover:bg-elevated focus-visible:ring-pink/40",
  danger:
    "bg-negative/15 text-negative hover:bg-negative/25 focus-visible:ring-negative/50 disabled:bg-negative/10",
};

/** Size -> class map (height, horizontal padding, text size). */
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[12px]",
  md: "h-11 px-5 text-[14px]",
  lg: "h-12 px-6 text-[15px]",
};

/**
 * Themed button. Forwards a ref to the underlying `<button>` so callers can
 * focus or measure it. `disabled` and `loading` both prevent the click; when
 * `loading`, a spinner replaces the `leading` slot so the busy state is visible.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    leading,
    trailing,
    className,
    disabled,
    type = "button",
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-card font-semibold",
        "transition-colors outline-none focus-visible:ring-2",
        "disabled:cursor-not-allowed disabled:opacity-70",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 flex-none animate-spin rounded-full border-[1.5px] border-current/30 border-t-current"
        />
      ) : leading ? (
        <span className="flex flex-none items-center">{leading}</span>
      ) : null}

      {children}

      {trailing ? (
        <span className="flex flex-none items-center">{trailing}</span>
      ) : null}
    </button>
  );
});
