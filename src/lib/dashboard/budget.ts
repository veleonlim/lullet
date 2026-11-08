import { allocateProportional } from "@/lib/money";

/**
 * How full a budget is. Under 80% is fine, 80% up to and including 100% is near, anything
 * above 100% is over. `none` means no budget is set for the day.
 */
export type BudgetState = "none" | "under" | "near" | "over";

/** Spending at or above this share of the budget is "near". */
export const NEAR_PERCENT = 80;

export function budgetState(spentMinor: number, budgetMinor: number | null): BudgetState {
  if (budgetMinor === null) return "none";
  if (spentMinor <= 0) return "under";
  if (spentMinor > budgetMinor) return "over";
  return spentMinor * 100 >= budgetMinor * NEAR_PERCENT ? "near" : "under";
}

export interface BudgetSettings {
  /** The group's daily budget in SGD minor units; null when none is set. */
  readonly defaultMinor: number | null;
  /** Budgets for single days, overriding the default. */
  readonly overrides: ReadonlyMap<string, number>;
}

export type BudgetSource = "override" | "default" | "none";

/** The budget in force on a day: its own override, else the default, else none. */
export function budgetFor(
  day: string,
  settings: BudgetSettings,
): { amountMinor: number | null; source: BudgetSource } {
  const override = settings.overrides.get(day);
  if (override !== undefined) return { amountMinor: override, source: "override" };
  if (settings.defaultMinor !== null)
    return { amountMinor: settings.defaultMinor, source: "default" };
  return { amountMinor: null, source: "none" };
}

/**
 * Each member's slice of a day's budget: the budget divided by the number of members, with any
 * spare cents going to the first members in the fixed order, so the slices add up to the budget.
 */
export function splitBudget(
  budgetMinor: number,
  memberIds: readonly string[],
): Record<string, number> {
  if (memberIds.length === 0) return {};
  const parts = allocateProportional(
    budgetMinor,
    memberIds.map(() => 1),
  );
  return Object.fromEntries(memberIds.map((id, i) => [id, parts[i] ?? 0]));
}
