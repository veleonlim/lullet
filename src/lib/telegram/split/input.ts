import { CATEGORIES, type CategoryId } from "@/lib/ledger/categories";
import { MAX_DESCRIPTION_LENGTH, readPositiveAmount } from "@/lib/ledger/fields";
import { isIsoDate, parseAmount, type CurrencyCode } from "@/lib/money";
import { parseTypedPercents } from "@/lib/telegram/percent";

/**
 * Reading what a person types in answer to the /split questions. Each reader returns the value or
 * a short message to say back; none of them throws for bad input. The amount and date rules are
 * the web form's (`readPositiveAmount`, `isIsoDate`); the expense is validated once more as a whole
 * before it is saved.
 */

export type Read<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function readTitle(text: string): Read<string> {
  const title = text.replace(/\s+/g, " ").trim();
  if (title === "") return fail("Type what the expense was for, like Dinner.");
  if (title.length > MAX_DESCRIPTION_LENGTH) {
    return fail(`Keep it under ${String(MAX_DESCRIPTION_LENGTH)} characters.`);
  }
  return { ok: true, value: title };
}

export interface TypedAmount {
  readonly minor: number;
  readonly currency: CurrencyCode;
}

const AMOUNT_HELP = "Try 45, S$45 or 100 EUR.";

/**
 * "100 EUR", "EUR 100", "S$45", "€12.50" or a bare "45". A bare number (or a bare "$") is in
 * `fallback`; a currency that is written must be one the app knows, and is never guessed.
 */
export function readAmount(text: string, fallback: CurrencyCode): Read<TypedAmount> {
  const trimmed = text.trim();
  let parsed = parseAmount(trimmed);
  if (!parsed.ok && parsed.reason === "currency_unknown") {
    parsed = parseAmount(trimmed, { currency: fallback });
  }
  if (!parsed.ok) {
    switch (parsed.reason) {
      case "empty":
      case "invalid_format":
        return fail(`That is not an amount. ${AMOUNT_HELP}`);
      case "too_many_decimals":
        return fail("Too many decimal places for that currency.");
      case "out_of_range":
        return fail("That amount is too large.");
      case "currency_unsupported":
        return fail(`I do not know that currency. ${AMOUNT_HELP}`);
      case "currency_unknown":
      case "currency_mismatch":
        return fail(
          `Which currency is that? Write it out: S$45 for SGD, US$45 for USD, or 45 EUR.`,
        );
    }
  }
  if (parsed.warnings.length > 0) {
    return fail("Unclear amount: type the decimals, like 1234.00 or 1.23.");
  }
  if (parsed.minor <= 0) return fail("The amount must be more than zero.");
  return { ok: true, value: { minor: parsed.minor, currency: parsed.currency } };
}

/** Separators between typed numbers: spaces, "/" and ";", or a comma followed by a space. */
const NUMBER_SEPARATOR = /\s*[/;]\s*|,\s+|\s+/;

/**
 * Amounts typed one per person in the order shown ("60 40", "12,50 / 7.5"). Leaving the last one
 * out gives them the rest of the total. Returns minor units per person; whether they add up to
 * the total is the expense validator's call.
 */
export function readAmountList(
  text: string,
  userIds: readonly string[],
  currency: CurrencyCode,
  total: number,
): Read<Record<string, number>> {
  const tokens = text.split(NUMBER_SEPARATOR).filter((token) => token !== "");
  if (tokens.length === 0) return fail("Type one amount per person, like 60 40.");
  if (tokens.length !== userIds.length && tokens.length !== userIds.length - 1) {
    return fail(`Send ${String(userIds.length)} amounts, one per person in the order shown.`);
  }
  const minors: number[] = [];
  for (const token of tokens) {
    const amount = readPositiveAmount(token, currency);
    if (!amount.ok) return fail(`"${token}": ${amount.message}.`);
    minors.push(amount.minor);
  }
  if (minors.length < userIds.length) {
    const rest = total - minors.reduce((sum, minor) => sum + minor, 0);
    if (rest <= 0) return fail("Those amounts already add up to the total or more.");
    minors.push(rest);
  }
  return { ok: true, value: Object.fromEntries(userIds.map((id, i) => [id, minors[i] ?? 0])) };
}

/** Percentages typed one per person ("60 40", "60/40"); basis points, each above zero. */
export function readPercentList(
  text: string,
  userIds: readonly string[],
): Read<Record<string, number>> {
  const typed = parseTypedPercents(text, userIds);
  if (!typed.ok) return fail(typed.message);
  if (Object.values(typed.percents).some((basisPoints) => basisPoints <= 0)) {
    return fail("Everyone needs more than 0%. Take them off the shared list instead.");
  }
  return { ok: true, value: { ...typed.percents } };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthOf(name: string): number | null {
  const index = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return index >= 0 && /^[A-Za-z]{3,9}$/.test(name) ? index + 1 : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Today's date plus `days`, as a calendar day. Only the calendar is shifted, never a time of day. */
export function shiftDay(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return `${String(moved.getUTCFullYear())}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/**
 * A day typed as 2026-11-08, 8/11, 8/11/2026, 8 Nov, Nov 8 or 8 Nov 2026, or "today" and
 * "yesterday". Day before month, as people write it in Europe and Singapore. A missing year is
 * `today`'s year.
 */
export function readDay(text: string, today: string): Read<string> {
  const input = text.trim().toLowerCase();
  if (input === "today") return { ok: true, value: today };
  if (input === "yesterday") return { ok: true, value: shiftDay(today, -1) };

  const year = Number(today.slice(0, 4));
  let candidate: string | null = null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  const numeric = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(input);
  const dayMonth = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/.exec(input);
  const monthDay = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(input);
  if (iso) {
    candidate = `${iso[1] ?? ""}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`;
  } else if (numeric) {
    candidate = `${numeric[3] ?? String(year)}-${pad(Number(numeric[2]))}-${pad(Number(numeric[1]))}`;
  } else if (dayMonth) {
    const month = monthOf(dayMonth[2] ?? "");
    if (month !== null) {
      candidate = `${dayMonth[3] ?? String(year)}-${pad(month)}-${pad(Number(dayMonth[1]))}`;
    }
  } else if (monthDay) {
    const month = monthOf(monthDay[1] ?? "");
    if (month !== null) {
      candidate = `${monthDay[3] ?? String(year)}-${pad(month)}-${pad(Number(monthDay[2]))}`;
    }
  }
  if (
    candidate === null ||
    !isIsoDate(candidate) ||
    candidate < "2000-01-01" ||
    candidate > "2100-12-31"
  ) {
    return fail("I could not read that date. Try 2026-11-08, 8/11 or 8 Nov.");
  }
  return { ok: true, value: candidate };
}

/** A category typed by name ("transport") or by label. */
export function readCategory(text: string): Read<CategoryId> {
  const wanted = text.trim().toLowerCase();
  const found = CATEGORIES.find(
    (category) => category.id === wanted || category.label.toLowerCase() === wanted,
  );
  return found
    ? { ok: true, value: found.id }
    : fail(`Pick one of: ${CATEGORIES.map((category) => category.label).join(", ")}.`);
}
