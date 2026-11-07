import { REPORTING_CURRENCY, type CurrencyCode } from "./currency";
import { assertIsoDate, type IsoDate } from "./dates";
import { MoneyError } from "./errors";
import { assertPositiveMinor, type Minor } from "./integer";
import { convertMinor, parseRate, type Rate } from "./rate";

/**
 * Converting a native amount into the reporting currency (SGD), following the
 * agreed precedence. The first that applies wins:
 *   1. native    the expense is already in SGD
 *   2. billed    the bank billed an exact SGD figure
 *   3. expense_rate  a rate set on this single expense
 *   4. day_override  the day's default rate, set by a member
 *   5. market    the day's fetched market rate
 * With none of these available the conversion fails loudly; it never guesses.
 */

export type ConversionSource = "native" | "billed" | "expense_rate" | "day_override" | "market";

export interface BilledAmount {
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
}

export interface ConvertibleAmount {
  readonly date: IsoDate;
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
  /** What the card was actually billed, when the screenshot shows it. */
  readonly billed?: BilledAmount | undefined;
  /** A rate (SGD per 1 unit of `currency`) set on this one expense. */
  readonly rate?: Rate | undefined;
}

export interface Conversion {
  readonly sgdMinor: Minor;
  readonly source: ConversionSource;
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
    return { sgdMinor: amount.amountMinor, source: "native" };
  }

  if (amount.billed?.currency === REPORTING_CURRENCY) {
    assertPositiveMinor(amount.billed.amountMinor, "billed amount");
    return { sgdMinor: amount.billed.amountMinor, source: "billed" };
  }

  const chosen = pickRate(amount, book);
  if (!chosen) {
    throw new MoneyError(
      "missing_rate",
      `No ${amount.currency} to ${REPORTING_CURRENCY} rate for ${amount.date}`,
    );
  }
  return {
    sgdMinor: convertMinor(amount.amountMinor, amount.currency, REPORTING_CURRENCY, chosen.rate),
    source: chosen.source,
    rate: chosen.rate,
  };
}

function pickRate(
  amount: ConvertibleAmount,
  book: RateBook,
): { rate: Rate; source: ConversionSource } | undefined {
  if (amount.rate) return { rate: amount.rate, source: "expense_rate" };
  const override = book.dayOverride(amount.date, amount.currency);
  if (override) return { rate: override, source: "day_override" };
  const market = book.market(amount.date, amount.currency);
  if (market) return { rate: market, source: "market" };
  return undefined;
}
