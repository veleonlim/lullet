import { toLedgerExpense, type PricingSnapshot, type StoredExpense } from "@/lib/ledger";
import {
  assertCurrencyCode,
  formatRate,
  MoneyError,
  REPORTING_CURRENCY,
  toReportingCurrency,
  type CurrencyCode,
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

/**
 * Whether a day's rate for `currency` can matter to this expense at all. A native SGD amount,
 * an exact billed SGD figure and a rate typed on the expense itself always win over a day rate.
 */
export function usesDayRate(expense: StoredExpense, currency: CurrencyCode): boolean {
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

/** The expenses whose SGD figure (or the way it was decided) differs between two sets of rates. */
export function diffPricing(
  expenses: readonly StoredExpense[],
  before: RateBook,
  after: RateBook,
): RepriceChange[] {
  const changes: RepriceChange[] = [];
  for (const expense of expenses) {
    const was = pricingOf(expense, before);
    const now = pricingOf(expense, after);
    if (!samePricing(was, now)) {
      changes.push({
        expenseId: expense.id,
        description: expense.description,
        spentOn: expense.spentOn,
        before: was,
        after: now,
      });
    }
  }
  return changes;
}
