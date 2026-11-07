import { z } from "zod";
import {
  isCurrencyCode,
  isIsoDate,
  MoneyError,
  parseAmount,
  parseRate,
  REPORTING_CURRENCY,
  type BilledAmount,
  type CurrencyCode,
  type CurrencyRate,
  type ParseFailure,
} from "@/lib/money";

/**
 * Field level parsing shared by the expense and settlement forms. Every form
 * value arrives as text from the browser and is untrusted: it is shaped with zod
 * and read into integer minor units with the money library, which never guesses.
 */

/** Messages keyed by field name, e.g. `amount` or `payers.<userId>`. The first message wins. */
export type FieldErrors = Record<string, string>;

export type Validated<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: FieldErrors };

export class ErrorCollector {
  readonly errors: FieldErrors = {};

  add(field: string, message: string): void {
    this.errors[field] ??= message;
  }

  get hasErrors(): boolean {
    return Object.keys(this.errors).length > 0;
  }
}

/** Turns zod issues into field errors. Paths are joined with dots, e.g. `billed.amount`. */
export function zodFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join(".") || "form";
    errors[field] ??= issue.message;
  }
  return errors;
}

/** Runs one zod field schema; records its first message and returns the parsed value on success. */
export function readField<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
  errors: ErrorCollector,
): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  errors.add(field, result.error.issues[0]?.message ?? "Check this field");
  return undefined;
}

export const MAX_DESCRIPTION_LENGTH = 120;
export const MAX_NOTE_LENGTH = 280;
const EARLIEST_DATE = "2000-01-01";
const LATEST_DATE = "2100-12-31";

export const descriptionField = z
  .string()
  .trim()
  .min(1, "Add a description")
  .max(MAX_DESCRIPTION_LENGTH, `Keep it under ${String(MAX_DESCRIPTION_LENGTH)} characters`);

export const dateField = z
  .string()
  .refine(
    (value) => isIsoDate(value) && value >= EARLIEST_DATE && value <= LATEST_DATE,
    "Pick a valid date",
  );

// Not a type guard on purpose: form state holds plain strings until validated.
export const currencyField = z
  .string()
  .refine((value): boolean => isCurrencyCode(value), "Pick a supported currency");

/** The optional "billed by the bank" and "my own rate" sections: absent when closed or empty. */
export const billedFormSchema = z.object({ amount: z.string(), currency: z.string() });
export const rateFormSchema = z.object({ rate: z.string(), currency: z.string() });

const AMOUNT_MESSAGES: Record<ParseFailure, string> = {
  empty: "Enter an amount",
  invalid_format: "Enter an amount like 48.50",
  too_many_decimals: "Too many decimal places for this currency",
  out_of_range: "That amount is too large",
  // The currency has its own picker, so the amount field takes digits only.
  currency_unknown: "Type just the number, e.g. 48.50",
  currency_unsupported: "Type just the number, e.g. 48.50",
  currency_mismatch: "Type just the number; the currency has its own field",
};

/** Reads a positive amount in `currency`. Ambiguous input such as "1.234" is refused, not guessed. */
export function readPositiveAmount(
  text: string,
  currency: CurrencyCode,
): { ok: true; minor: number } | { ok: false; message: string } {
  const parsed = parseAmount(text, { currency });
  if (!parsed.ok) return { ok: false, message: AMOUNT_MESSAGES[parsed.reason] };
  if (parsed.warnings.length > 0) {
    return { ok: false, message: "Unclear amount: type the decimals, e.g. 1234.00 or 1.23" };
  }
  if (parsed.minor <= 0) return { ok: false, message: "The amount must be more than zero" };
  return { ok: true, minor: parsed.minor };
}

/** Reads an exchange rate such as "1.5340" (a comma decimal is accepted). */
export function readRate(
  text: string,
): { ok: true; rate: ReturnType<typeof parseRate> } | { ok: false; message: string } {
  const cleaned = text.trim().replace(/^(\d+),(\d+)$/, "$1.$2");
  if (cleaned === "") return { ok: false, message: "Enter a rate" };
  try {
    return { ok: true, rate: parseRate(cleaned) };
  } catch (error) {
    if (error instanceof MoneyError) {
      return { ok: false, message: "Enter a rate like 1.5340 (up to 10 decimals, above zero)" };
    }
    throw error;
  }
}

export interface ForeignAmountInput {
  readonly currency: CurrencyCode;
  readonly billed: z.infer<typeof billedFormSchema> | null;
  readonly rate: z.infer<typeof rateFormSchema> | null;
}

/**
 * Reads the optional billed amount and per-record rate. A section the person opened
 * but left without an amount (or rate) counts as absent. The rate is checked against the currency
 * that will actually be converted so it is never silently ignored.
 */
export function readBilledAndRate(
  input: ForeignAmountInput,
  errors: ErrorCollector,
): { billed: BilledAmount | null; rate: CurrencyRate | null } {
  let billed: BilledAmount | null = null;
  if (input.billed && input.billed.amount.trim() !== "") {
    if (!isCurrencyCode(input.billed.currency)) {
      errors.add("billed.currency", "Pick the billed currency");
    } else {
      const amount = readPositiveAmount(input.billed.amount, input.billed.currency);
      if (amount.ok) billed = { amountMinor: amount.minor, currency: input.billed.currency };
      else errors.add("billed.amount", amount.message);
    }
  }

  let rate: CurrencyRate | null = null;
  if (input.rate && input.rate.rate.trim() !== "") {
    if (!isCurrencyCode(input.rate.currency)) {
      errors.add("rate.currency", "Pick the currency this rate is for");
    } else if (input.rate.currency === REPORTING_CURRENCY) {
      errors.add("rate.currency", "Rates are SGD per 1 unit of a foreign currency");
    } else {
      const parsed = readRate(input.rate.rate);
      if (parsed.ok) rate = { currency: input.rate.currency, rate: parsed.rate };
      else errors.add("rate.rate", parsed.message);
    }
  }

  if (rate) {
    const converted = billed?.currency ?? input.currency;
    if (converted === REPORTING_CURRENCY) {
      errors.add("rate.rate", "Not needed: this is already in SGD");
    } else if (rate.currency !== converted) {
      errors.add(
        "rate.currency",
        billed
          ? `The bank billed in ${converted}, so the rate must be for ${converted}`
          : `The amount is in ${converted}, so the rate must be for ${converted}`,
      );
    }
  }
  return { billed, rate };
}
