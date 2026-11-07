import type { ComponentProps, ReactNode } from "react";
import { CURRENCY_CODES, type CurrencyCode } from "@/lib/money";
import { PREFERRED_CURRENCIES } from "@/lib/ledger";

const FIELD =
  "block w-full min-h-11 rounded-xl border bg-surface px-3.5 text-base text-foreground placeholder:text-muted/70 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:opacity-60";

export function fieldClass(invalid: boolean, extra = ""): string {
  return `${FIELD} ${invalid ? "border-negative" : "border-border-strong"} ${extra}`.trim();
}

/** A labelled control with an optional hint and an error announced to screen readers. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className = "",
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
      <FieldMessage id={`${htmlFor}-message`} error={error} hint={hint} />
    </div>
  );
}

export function FieldMessage({
  id,
  error,
  hint,
}: {
  id: string;
  error?: string | undefined;
  hint?: ReactNode;
}) {
  if (error) {
    return (
      <p id={id} role="alert" className="mt-1.5 text-sm text-negative">
        {error}
      </p>
    );
  }
  return hint ? (
    <p id={id} className="mt-1.5 text-sm text-muted">
      {hint}
    </p>
  ) : null;
}

/** Currencies with the trip's own first, then the rest alphabetically. */
export function orderedCurrencies(): CurrencyCode[] {
  const rest = CURRENCY_CODES.filter((code) => !PREFERRED_CURRENCIES.includes(code)).sort();
  return [...PREFERRED_CURRENCIES, ...rest];
}

export function CurrencySelect({
  invalid = false,
  className = "",
  ...props
}: Omit<ComponentProps<"select">, "className"> & { invalid?: boolean; className?: string }) {
  return (
    <select
      {...props}
      aria-invalid={invalid || undefined}
      className={fieldClass(invalid, className)}
    >
      {orderedCurrencies().map((code) => (
        <option key={code} value={code}>
          {code}
        </option>
      ))}
    </select>
  );
}

/** A decimal text box: the phone shows a number pad but the field still accepts "12,50". */
export function AmountInput({
  invalid = false,
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "className" | "type"> & {
  invalid?: boolean;
  className?: string;
}) {
  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      aria-invalid={invalid || undefined}
      className={fieldClass(invalid, `num ${className}`)}
    />
  );
}

/** Radio options drawn as chips; real radio inputs underneath, so the keyboard works. */
export function ChipRadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  columns = "grid-cols-3",
  hideLegend = false,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { id: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  columns?: string;
  hideLegend?: boolean;
}) {
  return (
    <fieldset>
      <legend className={hideLegend ? "sr-only" : "mb-1.5 text-sm font-medium"}>{legend}</legend>
      <div className={`grid gap-2 ${columns}`}>
        {options.map((option) => (
          <label key={option.id} className="relative block cursor-pointer">
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => {
                onChange(option.id);
              }}
              className="peer sr-only"
            />
            <span className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border-strong bg-surface px-2 text-sm font-medium text-muted transition-colors peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
              {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
