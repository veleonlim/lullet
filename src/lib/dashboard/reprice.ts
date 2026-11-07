import { toLedgerExpense, type PricingSnapshot, type StoredExpense } from "@/lib/ledger";
import {
  assertCurrencyCode,
  bookRate,
  createRateBook,
  formatRate,
  MoneyError,
  parseRate,
  REPORTING_CURRENCY,
  toReportingCurrency,
  type CurrencyCode,
  type PricedRate,
  type RateBook,
} from "@/lib/money";

/** What one expense is worth in SGD, and how that was decided. */
export type Pricing = PricingSnapshot;

/** Prices one expense through the usual precedence; null when no exchange rate is known. */
export function pricingOf(expense: StoredExpense, book: RateBook): Pricing | null {
  try {
    const conversion = toReportingCurrency(toLedgerExpense(expense), book);
    return {
      sgdMinor: conversion.sgdMinor,
      source: conversion.source,
      rate: conversion.rate ? formatRate(conversion.rate) : null,
    };
  } catch (error) {
    if (error instanceof MoneyError && error.code === "missing_rate") return null;
    throw error;
  }
}

/** The currency whose rate prices this expense: the billed currency when the bank billed one, else the shown one. */
export function convertedCurrency(
  expense: Pick<StoredExpense, "currency" | "billedCurrency">,
): CurrencyCode {
  return assertCurrencyCode(expense.billedCurrency ?? expense.currency);
}

type RateDecided = Pick<StoredExpense, "currency" | "billedCurrency" | "rate" | "rateCurrency">;

/**
 * Whether a day's rate for `currency` can matter to this expense or settlement at all. A native SGD
 * amount, an exact billed SGD figure and a rate typed on the record itself always win over a day rate.
 */
export function usesDayRate(expense: RateDecided, currency: CurrencyCode): boolean {
  if (expense.currency === REPORTING_CURRENCY || expense.billedCurrency === REPORTING_CURRENCY) {
    return false;
  }
  if (convertedCurrency(expense) !== currency) return false;
  return !(expense.rateCurrency === currency && expense.rate !== null);
}

export interface RepriceChange {
  readonly expenseId: string;
  readonly description: string;
  readonly spentOn: string;
  readonly before: Pricing | null;
  readonly after: Pricing | null;
}

function samePricing(a: Pricing | null, b: Pricing | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sgdMinor === b.sgdMinor && a.source === b.source && a.rate === b.rate;
}

/** Whether a record already carries exactly this stored rate (or none, for a null target). */
export function hasPricedRate(
  record: Pick<StoredExpense, "pricedRate" | "pricedRateCurrency" | "pricedSource">,
  target: PricedRate | null,
): boolean {
  if (target === null) return record.pricedRate === null;
  return (
    record.pricedRate !== null &&
    formatRate(parseRate(record.pricedRate)) === formatRate(target.rate) &&
    record.pricedRateCurrency === target.currency &&
    record.pricedSource === target.source
  );
}

/** What re-pricing one expense does: the rate it moves to and, if its figure or its basis changes, how. */
export interface RepriceStep {
  readonly expense: StoredExpense;
  /** The day's rate now (the group's own, else the market's); null when neither is stored. */
  readonly target: PricedRate | null;
  /** Null when the expense would keep its figure, its rate and the way it was decided. */
  readonly change: RepriceChange | null;
}

const NO_RATES: RateBook = createRateBook({});

/**
 * The expenses a day's rate decides (see `usesDayRate`) and what moving each to the book's current
 * rate would do. Expenses it does not decide are left out, so the list is exactly what re-pricing touches.
 */
export function planReprice(
  expenses: readonly StoredExpense[],
  currency: CurrencyCode,
  book: RateBook,
): RepriceStep[] {
  const steps: RepriceStep[] = [];
  for (const expense of expenses) {
    if (!usesDayRate(expense, currency)) continue;
    const target = bookRate(expense.spentOn, currency, book) ?? null;
    const before = pricingOf(expense, book);
    const after = pricingOf(
      {
        ...expense,
        pricedRate: target ? formatRate(target.rate) : null,
        pricedRateCurrency: target?.currency ?? null,
        pricedSource: target?.source ?? null,
      },
      NO_RATES,
    );
    steps.push({
      expense,
      target,
      change: samePricing(before, after)
        ? null
        : {
            expenseId: expense.id,
            description: expense.description,
            spentOn: expense.spentOn,
            before,
            after,
          },
    });
  }
  return steps;
}
