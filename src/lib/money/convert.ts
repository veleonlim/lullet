import { REPORTING_CURRENCY, type CurrencyCode } from "./currency";
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
 *   4. day_override  the day's default rate, set by a member
 *   5. market    the day's fetched market rate
 * Steps 3 to 5 convert the billed amount when the bank billed in a currency other
 * than SGD (the shown amount stays for reference), otherwise the shown amount;
 * `basis` says which. Rates are always SGD per 1 unit of that converted currency.
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
  /** A rate set on this one expense: SGD per 1 unit of the billed currency if billed, else of `currency`. */
  readonly rate?: Rate | undefined;
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
  const chosen = pickRate(amount.date, base.currency, amount.rate, book);
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
  date: IsoDate,
  currency: CurrencyCode,
  expenseRate: Rate | undefined,
  book: RateBook,
): { rate: Rate; source: ConversionSource } | undefined {
  if (expenseRate) return { rate: expenseRate, source: "expense_rate" };
  const override = book.dayOverride(date, currency);
  if (override) return { rate: override, source: "day_override" };
  const market = book.market(date, currency);
  if (market) return { rate: market, source: "market" };
  return undefined;
}
