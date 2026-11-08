import { z } from "zod";
import {
  dateField,
  ErrorCollector,
  readPositiveAmount,
  readRate,
  zodFieldErrors,
  type Validated,
} from "@/lib/ledger";
import {
  isCurrencyCode,
  REPORTING_CURRENCY,
  type CurrencyCode,
  type IsoDate,
  type Rate,
} from "@/lib/money";
import { daysBetween, isValidTimeZone } from "./trip";

/** The longest trip the settings accept: a year, which keeps every list and chart a sensible size. */
export const MAX_TRIP_DAYS = 366;

const text = z.string().default("");

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export interface BudgetInput {
  /** The day this budget is for; null sets the default for every day. */
  readonly day: IsoDate | null;
  readonly amountMinor: number;
}

/** A daily budget in SGD. `dayRequired` is for the per-day override form. */
export function validateBudgetForm(
  data: FormData,
  options: { dayRequired: boolean },
): Validated<BudgetInput> {
  const errors = new ErrorCollector();
  const amountText = formText(data, "amount");
  const dayText = formText(data, "day").trim();

  const amount = readPositiveAmount(amountText, REPORTING_CURRENCY);
  if (!amount.ok) errors.add("amount", amount.message);

  let day: IsoDate | null = null;
  if (options.dayRequired || dayText !== "") {
    const parsed = dateField.safeParse(dayText);
    if (parsed.success) day = parsed.data;
    else errors.add("day", dayText === "" ? "Pick a day" : "Pick a valid date");
  }
  if (errors.hasErrors || !amount.ok) return { ok: false, errors: errors.errors };
  return { ok: true, value: { day, amountMinor: amount.minor } };
}

export interface TripInput {
  readonly tripStart: IsoDate | null;
  readonly tripEnd: IsoDate | null;
  readonly timeZone: string;
}

const optionalDate = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(z.union([z.null(), dateField]));

/** The trip's dates (both optional) and time zone. */
export function validateTripForm(data: FormData): Validated<TripInput> {
  const parsed = z
    .object({
      tripStart: optionalDate,
      tripEnd: optionalDate,
      timeZone: text.pipe(z.string().trim()),
    })
    .safeParse({
      tripStart: formText(data, "tripStart"),
      tripEnd: formText(data, "tripEnd"),
      timeZone: formText(data, "timeZone"),
    });
  if (!parsed.success) return { ok: false, errors: zodFieldErrors(parsed.error) };

  const errors = new ErrorCollector();
  const { tripStart, tripEnd, timeZone } = parsed.data;
  if (!isValidTimeZone(timeZone)) errors.add("timeZone", "Pick a time zone like Europe/Zurich");
  if (tripStart && tripEnd) {
    if (tripEnd < tripStart) errors.add("tripEnd", "The trip cannot end before it starts");
    else if (daysBetween(tripStart, tripEnd) + 1 > MAX_TRIP_DAYS) {
      errors.add("tripEnd", `Keep the trip within ${String(MAX_TRIP_DAYS)} days`);
    }
  }
  if (errors.hasErrors) return { ok: false, errors: errors.errors };
  return { ok: true, value: { tripStart, tripEnd, timeZone } };
}

export interface DailyRateInput {
  readonly day: IsoDate;
  readonly currency: CurrencyCode;
  readonly rate: Rate;
}

/** The identity of a day rate: which day and which foreign currency. */
export function validateDayCurrency(
  data: FormData,
): Validated<{ day: IsoDate; currency: CurrencyCode }> {
  const errors = new ErrorCollector();
  const day = dateField.safeParse(formText(data, "day"));
  if (!day.success) errors.add("day", "Pick a valid date");
  const currency = formText(data, "currency");
  if (!isCurrencyCode(currency) || currency === REPORTING_CURRENCY) {
    errors.add("currency", "Pick a foreign currency");
  }
  if (errors.hasErrors || !day.success || !isCurrencyCode(currency)) {
    return { ok: false, errors: errors.errors };
  }
  return { ok: true, value: { day: day.data, currency } };
}

/** A day's default rate: SGD per 1 unit of a foreign currency. */
export function validateRateForm(data: FormData): Validated<DailyRateInput> {
  const identity = validateDayCurrency(data);
  const errors = new ErrorCollector();
  if (!identity.ok) Object.assign(errors.errors, identity.errors);
  const rate = readRate(formText(data, "rate"));
  if (!rate.ok) errors.add("rate", rate.message);
  if (errors.hasErrors || !identity.ok || !rate.ok) return { ok: false, errors: errors.errors };
  return { ok: true, value: { ...identity.value, rate: rate.rate } };
}
