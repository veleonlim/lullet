import {
  formatMoney,
  toLedgerExpense,
  toLedgerSettlement,
  type PricingSnapshot,
  type StoredExpense,
  type StoredSettlement,
} from "@/lib/ledger";
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

/** What one expense or settlement is worth in SGD, and how that was decided. */
export type Pricing = PricingSnapshot;

/** An expense or a settlement: the two kinds of record a day's rate can price. */
export type Repriceable = StoredExpense | StoredSettlement;

function dateOf(record: Repriceable): string {
  return "spentOn" in record ? record.spentOn : record.settledOn;
}

/** Prices one record through the usual precedence; null when no exchange rate is known. */
export function pricingOf(record: Repriceable, book: RateBook): Pricing | null {
  try {
    const conversion = toReportingCurrency(
      "spentOn" in record ? toLedgerExpense(record) : toLedgerSettlement(record),
      book,
    );
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
  readonly kind: "expense" | "settlement";
  readonly id: string;
  readonly description: string;
  readonly date: string;
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

/** What re-pricing one record does: the rate it moves to and, if its figure or its basis changes, how. */
export interface RepriceStep<T extends Repriceable = Repriceable> {
  readonly record: T;
  /** The day's rate now (the group's own, else the market's); null when neither is stored. */
  readonly target: PricedRate | null;
  /** Null when the record would keep its figure, its rate and the way it was decided. */
  readonly change: RepriceChange | null;
}

const NO_RATES: RateBook = createRateBook({});

function describeRecord(record: Repriceable): string {
  return "description" in record
    ? record.description
    : `Settlement of ${formatMoney(record.amountMinor, assertCurrencyCode(record.currency))}`;
}

/**
 * The records a day's rate decides (see `usesDayRate`) and what moving each to the book's current
 * rate would do. Records it does not decide are left out, so the list is exactly what re-pricing touches.
 */
export function planReprice<T extends Repriceable>(
  records: readonly T[],
  currency: CurrencyCode,
  book: RateBook,
): RepriceStep<T>[] {
  const steps: RepriceStep<T>[] = [];
  for (const record of records) {
    if (!usesDayRate(record, currency)) continue;
    const target = bookRate(dateOf(record), currency, book) ?? null;
    const before = pricingOf(record, book);
    const after = pricingOf(
      {
        ...record,
        pricedRate: target ? formatRate(target.rate) : null,
        pricedRateCurrency: target?.currency ?? null,
        pricedSource: target?.source ?? null,
      },
      NO_RATES,
    );
    steps.push({
      record,
      target,
      change: samePricing(before, after)
        ? null
        : {
            kind: "description" in record ? "expense" : "settlement",
            id: record.id,
            description: describeRecord(record),
            date: dateOf(record),
            before,
            after,
          },
    });
  }
  return steps;
}

/** "1 expense", "2 settlements" or "1 expense and 1 settlement"; empty when both are zero. */
export function describeCount(expenses: number, settlements: number): string {
  const parts: string[] = [];
  if (expenses > 0) parts.push(`${String(expenses)} ${expenses === 1 ? "expense" : "expenses"}`);
  if (settlements > 0) {
    parts.push(`${String(settlements)} ${settlements === 1 ? "settlement" : "settlements"}`);
  }
  return parts.join(" and ");
}
