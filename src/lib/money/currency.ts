/**
 * ISO 4217 currency table: the currencies lullet accepts and their minor-unit
 * exponent (number of decimal digits). Money is always stored as an integer
 * count of minor units, so the exponent is the only place decimals live.
 */

/** The single currency used for charts, budgets, balances and settle-up. */
export const REPORTING_CURRENCY = "SGD" as const;

const EXPONENTS = {
  // Home currency and the trip currencies.
  SGD: 2,
  EUR: 2,
  CHF: 2,
  // Other European currencies a traveller may meet.
  GBP: 2,
  DKK: 2,
  NOK: 2,
  SEK: 2,
  ISK: 0,
  PLN: 2,
  CZK: 2,
  HUF: 2,
  RON: 2,
  BGN: 2,
  RSD: 2,
  MKD: 2,
  ALL: 2,
  BAM: 2,
  MDL: 2,
  UAH: 2,
  TRY: 2,
  // Common travel currencies outside Europe, covering the 0 and 2 digit cases.
  USD: 2,
  JPY: 0,
} as const;

export type CurrencyCode = keyof typeof EXPONENTS;

export const CURRENCY_CODES = Object.freeze(Object.keys(EXPONENTS) as CurrencyCode[]);

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.hasOwn(EXPONENTS, value);
}

/** Throws a RangeError for anything that is not a supported ISO 4217 code. */
export function assertCurrencyCode(value: unknown): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new RangeError(`Unsupported currency code: ${String(value)}`);
  }
  return value;
}

/** Number of decimal digits of the currency (2 for EUR, 0 for JPY). */
export function minorUnitExponent(currency: CurrencyCode): number {
  return EXPONENTS[currency];
}
