import { REPORTING_CURRENCY, assertCurrencyCode, type CurrencyCode } from "./currency";
import { assertIsoDate, type IsoDate } from "./dates";
import { MoneyError } from "./errors";
import { assertPositiveMinor, type Minor } from "./integer";
import { convertMinor, parseRate, type Rate } from "./rate";

/**
 * Converting an amount into the reporting currency (SGD), following the agreed
 * precedence. The first that applies wins:
 *   1. native    the expense is shown in SGD
 *   2. billed    the bank billed an exact SGD figure
 *   3. expense_rate  a rate set on this single expense
 *   4. the rate the record was priced with when it was saved or last re-priced,
 *      reported as the source it came from (day_override or market)
 *   5. day_override  the day's default rate, set by a member
 *   6. market    the day's fetched market rate
 * Steps 5 and 6 only apply to a record that has no stored rate of its own, so a day's
 * rate changing never moves a figure that was already priced.
 * Steps 3 to 5 convert the billed amount when the bank billed in a currency other
 * than SGD (the shown amount stays for reference), otherwise the shown amount;
 * `basis` says which. Rates are always SGD per 1 unit of that converted currency.
 * A rate set on the expense names its own currency and is applied only to an
 * amount in that currency; otherwise it is skipped, never reinterpreted.
 * With none of these available the conversion fails loudly; it never guesses.
 */

export type ConversionSource = "native" | "billed" | "expense_rate" | "day_override" | "market";

export interface BilledAmount {
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
}

/** SGD per 1 unit of `currency`. */
export interface CurrencyRate {
  readonly currency: CurrencyCode;
  readonly rate: Rate;
}

/** The rate a record was priced with, kept so the figure does not move when the day's rates do. */
export interface PricedRate extends CurrencyRate {
  readonly source: "day_override" | "market";
}

export interface ConvertibleAmount {
  readonly date: IsoDate;
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
  /** What the card was actually billed, when the screenshot shows it. */
  readonly billed?: BilledAmount | undefined;
  /** A rate set on this one expense. */
  readonly rate?: CurrencyRate | undefined;
  /** The rate this amount was priced with at its last save or re-price. */
  readonly priced?: PricedRate | undefined;
}

export interface Conversion {
  readonly sgdMinor: Minor;
  readonly source: ConversionSource;
  /** Which amount was converted: the one shown on the receipt or the one the bank billed. */
  readonly basis: "shown" | "billed";
  /** The rate applied; absent for native and billed conversions. */
  readonly rate?: Rate;
}

/** Looks up SGD-per-unit rates for a day. Rates are stored when first used so history never moves. */
export interface RateBook {
  dayOverride(date: IsoDate, currency: CurrencyCode): Rate | undefined;
  market(date: IsoDate, currency: CurrencyCode): Rate | undefined;
}

export interface RateEntry {
  readonly date: IsoDate;
  readonly currency: CurrencyCode;
  readonly rate: Rate | string;
}

const key = (date: IsoDate, currency: CurrencyCode) => `${date}|${currency}`;

function indexEntries(entries: readonly RateEntry[]): Map<string, Rate> {
  const index = new Map<string, Rate>();
  for (const entry of entries) {
    assertIsoDate(entry.date, "rate date");
    const rate = typeof entry.rate === "string" ? parseRate(entry.rate) : entry.rate;
    index.set(key(entry.date, entry.currency), rate);
  }
  return index;
}

/**
 * Maps a stored `fx_rates` or `daily_rates` row to a RateEntry. Every stored rate
 * is units of SGD per 1 unit of `base`, so a row quoted in anything else is refused.
 */
export function rateEntryFromRow(row: {
  readonly rateDate: string;
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
}): RateEntry {
  if (row.quote !== REPORTING_CURRENCY) {
    throw new MoneyError(
      "invalid_rate",
      `Stored rates must be quoted in ${REPORTING_CURRENCY}, got ${row.base}/${row.quote}`,
    );
  }
  return {
    date: assertIsoDate(row.rateDate, "rate date"),
    currency: assertCurrencyCode(row.base),
    rate: row.rate,
  };
}

/** Builds an in-memory RateBook from rows read from the database. */
export function createRateBook(input: {
  readonly overrides?: readonly RateEntry[];
  readonly market?: readonly RateEntry[];
}): RateBook {
  const overrides = indexEntries(input.overrides ?? []);
  const market = indexEntries(input.market ?? []);
  return {
    dayOverride: (date, currency) => overrides.get(key(date, currency)),
    market: (date, currency) => market.get(key(date, currency)),
  };
}

export function toReportingCurrency(amount: ConvertibleAmount, book: RateBook): Conversion {
  assertPositiveMinor(amount.amountMinor, "amount");
  assertIsoDate(amount.date);

  if (amount.currency === REPORTING_CURRENCY) {
    return { sgdMinor: amount.amountMinor, source: "native", basis: "shown" };
  }

  if (amount.billed?.currency === REPORTING_CURRENCY) {
    assertPositiveMinor(amount.billed.amountMinor, "billed amount");
    return { sgdMinor: amount.billed.amountMinor, source: "billed", basis: "billed" };
  }

  // A billed amount in another currency is what the card was really charged, so it is the one converted.
  const base: BilledAmount = amount.billed ?? {
    amountMinor: amount.amountMinor,
    currency: amount.currency,
  };
  assertPositiveMinor(base.amountMinor, "amount to convert");
  const chosen = pickRate(amount, base.currency, book);
  if (!chosen) {
    throw new MoneyError(
      "missing_rate",
      `No ${base.currency} to ${REPORTING_CURRENCY} rate for ${amount.date}`,
    );
  }
  return {
    sgdMinor: convertMinor(base.amountMinor, base.currency, REPORTING_CURRENCY, chosen.rate),
    source: chosen.source,
    basis: amount.billed ? "billed" : "shown",
    rate: chosen.rate,
  };
}

function pickRate(
  amount: ConvertibleAmount,
  currency: CurrencyCode,
  book: RateBook,
): { rate: Rate; source: ConversionSource } | undefined {
  if (amount.rate?.currency === currency) {
    return { rate: amount.rate.rate, source: "expense_rate" };
  }
  if (amount.priced?.currency === currency) {
    return { rate: amount.priced.rate, source: amount.priced.source };
  }
  return bookRate(amount.date, currency, book);
}

/** The day's rate in the book: the group's own rate if it set one, else the market rate. */
export function bookRate(
  date: IsoDate,
  currency: CurrencyCode,
  book: RateBook,
): PricedRate | undefined {
  const override = book.dayOverride(date, currency);
  if (override) return { currency, rate: override, source: "day_override" };
  const market = book.market(date, currency);
  if (market) return { currency, rate: market, source: "market" };
  return undefined;
}

/**
 * The currency whose rate prices this amount, or null when it is priced without one: native SGD,
 * billed in SGD, or a rate set on the record itself.
 */
export function ratePricedCurrency(
  amount: Pick<ConvertibleAmount, "currency" | "billed" | "rate">,
): CurrencyCode | null {
  if (amount.currency === REPORTING_CURRENCY || amount.billed?.currency === REPORTING_CURRENCY) {
    return null;
  }
  const currency = amount.billed?.currency ?? amount.currency;
  return amount.rate?.currency === currency ? null : currency;
}

/**
 * The rate to store on a record so its figure stays put: the book's rate for the currency that
 * gets converted (see `ratePricedCurrency`), or null when no rate prices the amount or the book has
 * none yet. Any `priced` rate on the amount is not consulted.
 */
export function pricedRateFor(amount: ConvertibleAmount, book: RateBook): PricedRate | null {
  const currency = ratePricedCurrency(amount);
  if (currency === null) return null;
  assertIsoDate(amount.date);
  return bookRate(amount.date, currency, book) ?? null;
}
