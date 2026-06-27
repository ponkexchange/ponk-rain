/**
 * Input primitive for the @ponkrain/launch scaffold.
 *
 * A labelled text/decimal field used by the amount and price inputs in the
 * LaunchForm and SwapWidget. Self-contained (no `@ponk/ui` dependency) and
 * styled with the design tokens from `tailwind.config.ts`.
 *
 * Features:
 *   - Optional `label` and `hint` rendered with consistent spacing/typography.
 *   - A `mono` variant that switches to tabular monospace figures, used for
 *     amount/price fields so digits line up and never reflow as the user types.
 *   - Optional `prefix` / `suffix` adornments (e.g. a `$` prefix or a token
 *     symbol / MAX button suffix) laid out inside the field chrome.
 *   - An `invalid` flag that recolors the border to the negative token for
 *     guard failures (same-mint, existing-pool, out-of-range price), with the
 *     `hint` doubling as the error message.
 *
 * Honesty note: this primitive never coerces or fabricates a value. Numeric
 * sanitisation (decimals-only, single dot) is left to the caller / SDK bridge
 * so that an empty field stays empty rather than defaulting to a fake `0`.
 */

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import clsx from "clsx";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  /** Field label rendered above the control. */
  label?: ReactNode;
  /** Helper or error text rendered below the control. */
  hint?: ReactNode;
  /** Use tabular monospace figures (amount / price fields). */
  mono?: boolean;
  /** Mark the field as invalid: negative border + negative hint color. */
  invalid?: boolean;
  /** Leading adornment inside the field chrome (e.g. `$`). */
  prefix?: ReactNode;
  /** Trailing adornment inside the field chrome (e.g. token symbol / MAX). */
  suffix?: ReactNode;
  /** Extra classes for the outer wrapper (the field owns its own width). */
  wrapperClassName?: string;
}

/**
 * Themed input. Wires up a generated id so the `label` is correctly associated
 * for accessibility when the caller does not supply one. Forwards a ref to the
 * underlying `<input>` so callers can focus it (e.g. after selecting a token).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    mono,
    invalid,
    prefix,
    suffix,
    className,
    wrapperClassName,
    id,
    type = "text",
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className={clsx("flex flex-col gap-1.5", wrapperClassName)}>
      {label ? (
        <label
          htmlFor={inputId}
          className="text-[12px] font-medium text-muted"
        >
          {label}
        </label>
      ) : null}

      <div
        className={clsx(
          "flex items-center gap-2 rounded-card border bg-elevated px-3",
          "transition-colors focus-within:border-pink/60",
          invalid ? "border-negative" : "border-line",
        )}
      >
        {prefix ? (
          <span className="flex-none text-[13px] text-muted">{prefix}</span>
        ) : null}

        <input
          ref={ref}
          id={inputId}
          type={type}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className={clsx(
            "min-w-0 flex-1 bg-transparent py-2.5 text-[14px] text-fg",
            "placeholder:text-muted/60 outline-none",
            mono && "font-mono tabular-nums",
            className,
          )}
          {...rest}
        />

        {suffix ? (
          <span className="flex flex-none items-center gap-1 text-[13px] text-muted">
            {suffix}
          </span>
        ) : null}
      </div>

      {hint ? (
        <span
          id={hintId}
          className={clsx(
            "text-[11px]",
            invalid ? "text-negative" : "text-muted",
          )}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
});
