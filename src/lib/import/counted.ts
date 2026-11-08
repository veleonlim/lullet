import { formatMoney } from "@/lib/ledger/format";
import { isCurrencyCode } from "@/lib/money";

/**
 * What a draft row counts for. When the bank billed an exact amount (a card app showing "EUR 100.00"
 * with "S$144.26" charged), the billed figure is what is recorded; the figure on the receipt is
 * kept for reference. Without a billed figure the receipt amount counts.
 */
export interface CountedAmount {
  readonly amountMinor: number;
  readonly currency: string;
  /** The receipt amount, when it differs from the counted one; null otherwise. */
  readonly receipt: { readonly amountMinor: number; readonly currency: string } | null;
}

/** A draft row or a stored expense: the receipt amount and what the bank billed, if anything. */
interface Priced {
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly billedAmountMinor: number | null;
  readonly billedCurrency: string | null;
}

export function countedAmount(row: Priced): CountedAmount | null {
  const receipt =
    row.amountMinor !== null && row.currency !== null
      ? { amountMinor: row.amountMinor, currency: row.currency }
      : null;
  if (row.billedAmountMinor !== null && row.billedCurrency !== null) {
    const differs =
      receipt !== null &&
      (receipt.currency !== row.billedCurrency || receipt.amountMinor !== row.billedAmountMinor);
    return {
      amountMinor: row.billedAmountMinor,
      currency: row.billedCurrency,
      receipt: differs ? receipt : null,
    };
  }
  return receipt === null ? null : { ...receipt, receipt: null };
}

function money(minor: number, currency: string): string {
  return isCurrencyCode(currency) ? formatMoney(minor, currency) : `${String(minor)} ${currency}`;
}

export function moneyText(amount: { amountMinor: number; currency: string }): string {
  return money(amount.amountMinor, amount.currency);
}

/** "S$144.26 (€100.00)" when a billed figure counts, "€100.00" otherwise, null without an amount. */
export function countedText(row: Priced): string | null {
  const counted = countedAmount(row);
  if (counted === null) return null;
  const main = moneyText(counted);
  return counted.receipt ? `${main} (${moneyText(counted.receipt)})` : main;
}
