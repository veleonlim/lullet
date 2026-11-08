import { formatMoney } from "@/lib/ledger";
import { NEAR_PERCENT, type BudgetState } from "@/lib/dashboard";
import { REPORTING_CURRENCY } from "@/lib/money";
import { Pill } from "@/components/ui";

const FILL: Record<BudgetState, string> = {
  under: "bg-positive",
  near: "bg-warning",
  over: "bg-negative",
  none: "bg-border-strong",
};

const STATE_TEXT: Record<BudgetState, string> = {
  under: "under budget",
  near: "near the budget",
  over: "over budget",
  none: "no budget set",
};

/** The state in words, so it is never carried by colour alone. */
export function BudgetStatePill({
  state,
  upcoming = false,
}: {
  state: BudgetState;
  upcoming?: boolean;
}) {
  if (upcoming) return <Pill>Upcoming</Pill>;
  const tone = { under: "positive", near: "warning", over: "negative", none: "neutral" } as const;
  const label = { under: "Under", near: "Near", over: "Over", none: "No budget" } as const;
  return (
    <span data-state={state} data-testid="budget-state">
      <Pill tone={tone[state]}>{label[state]}</Pill>
    </span>
  );
}

/**
 * Spending against a budget. Green below 80%, amber from 80% to 100%, red above 100%; a tick
 * marks the 80% line. Exposed to assistive technology as a meter with a spoken value.
 */
export function BudgetMeter({
  spentMinor,
  budgetMinor,
  state,
  label,
  size = "md",
}: {
  spentMinor: number;
  budgetMinor: number | null;
  state: BudgetState;
  /** What is being measured, e.g. "Today" or "Mei's share". */
  label: string;
  size?: "sm" | "md";
}) {
  if (budgetMinor === null) return null;
  const ratio = budgetMinor <= 0 ? (spentMinor > 0 ? 1 : 0) : Math.min(1, spentMinor / budgetMinor);
  const spoken = `${formatMoney(spentMinor, REPORTING_CURRENCY)} of ${formatMoney(budgetMinor, REPORTING_CURRENCY)}, ${STATE_TEXT[state]}`;
  return (
    <div
      role="meter"
      aria-label={`${label} against budget`}
      aria-valuemin={0}
      aria-valuemax={Math.max(budgetMinor, 1)}
      aria-valuenow={Math.min(spentMinor, Math.max(budgetMinor, 1))}
      aria-valuetext={spoken}
      data-state={state}
      data-testid="budget-meter"
      className={`relative w-full overflow-hidden rounded-full bg-surface-muted ${
        size === "sm" ? "h-1.5" : "h-2.5"
      }`}
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${FILL[state]}`}
        style={{ width: `${String(Math.round(ratio * 1000) / 10)}%` }}
      />
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-0.5 bg-surface/80"
        style={{ left: `${String(NEAR_PERCENT)}%` }}
      />
    </div>
  );
}
