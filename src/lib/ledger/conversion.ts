import { assertCurrencyCode, formatRate, type ExpenseInReportingCurrency } from "@/lib/money";
import type { StoredExpense, StoredSettlement } from "./types";

export interface ConversionText {
  /** What decided the SGD figure, e.g. "Market rate S$1.534 per EUR". Null when the amount is already SGD. */
  readonly headline: string | null;
  /** Extra context, e.g. which amount was converted. */
  readonly detail: string | null;
}

/** Explains in words how an expense's (or settlement's) SGD figure came about. */
export function describeConversion(
  record: Pick<StoredExpense | StoredSettlement, "currency" | "billedCurrency">,
  sgd: Pick<ExpenseInReportingCurrency, "source" | "basis" | "rate">,
): ConversionText {
  if (sgd.source === "native") return { headline: null, detail: null };
  if (sgd.source === "billed") {
    return { headline: "Exact figure billed by your bank in SGD", detail: null };
  }

  const billed = sgd.basis === "billed" && record.billedCurrency !== null;
  const converted = assertCurrencyCode(billed ? record.billedCurrency : record.currency);
  const label = {
    expense_rate: "Your rate",
    day_override: "Day rate",
    market: "Market rate",
  }[sgd.source];
  return {
    headline: `${label} S$${sgd.rate ? formatRate(sgd.rate) : "?"} per ${converted}`,
    detail: billed ? `Converted from the amount your bank billed in ${converted}` : null,
  };
}
