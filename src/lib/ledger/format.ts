import { AMOUNT_FORMATS, formatAmount, type CurrencyCode } from "@/lib/money";

/** Symbols for display. Currencies without one are shown as their code, e.g. "CHF 48.50". */
const SYMBOLS: Readonly<Partial<Record<CurrencyCode, string>>> = {
  SGD: "S$",
  EUR: "€",
  GBP: "£",
  USD: "US$",
  JPY: "¥",
};

export interface MoneyFormatOptions {
  /** Show a leading "+" for positive amounts (used for balances). */
  readonly signed?: boolean;
}

/** Formats minor units for people to read: "€48.50", "CHF 48.50", "S$1,234.00", "-€5.00". */
export function formatMoney(
  minor: number,
  currency: CurrencyCode,
  options: MoneyFormatOptions = {},
): string {
  const magnitude = formatAmount(Math.abs(minor), currency, AMOUNT_FORMATS.us);
  const symbol = SYMBOLS[currency];
  const body = symbol ? `${symbol}${magnitude}` : `${currency} ${magnitude}`;
  if (minor < 0) return `-${body}`;
  return options.signed && minor > 0 ? `+${body}` : body;
}

/** Formats minor units for an input field: digits and a decimal point only, e.g. "48.50". */
export function formatPlainAmount(minor: number, currency: CurrencyCode): string {
  return formatAmount(minor, currency, AMOUNT_FORMATS.plain);
}

/** Basis points as a percentage for an input field: 3333 is "33.33", 5000 is "50". */
export function formatBasisPoints(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = String(basisPoints % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${String(whole)}.${fraction}`;
}
