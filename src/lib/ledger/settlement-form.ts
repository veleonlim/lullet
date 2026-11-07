import { z } from "zod";
import type { BilledAmount, CurrencyCode, CurrencyRate, IsoDate } from "@/lib/money";
import {
  billedFormSchema,
  currencyField,
  dateField,
  ErrorCollector,
  MAX_NOTE_LENGTH,
  rateFormSchema,
  readBilledAndRate,
  readPositiveAmount,
  readField,
  type Validated,
} from "./fields";

/** What the "record settlement" form submits. */
export const settlementFormSchema = z.object({
  fromUserId: z.string(),
  toUserId: z.string(),
  settledOn: z.string(),
  amount: z.string(),
  currency: z.string(),
  billed: billedFormSchema.nullable(),
  rate: rateFormSchema.nullable(),
  note: z.string(),
});

const noteField = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH, `Keep the note under ${String(MAX_NOTE_LENGTH)} characters`);

export type SettlementFormValues = z.infer<typeof settlementFormSchema>;

/** A validated settlement: one member paying another, with the currency and rate handling of an expense. */
export interface SettlementInput {
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly settledOn: IsoDate;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly billed: BilledAmount | null;
  readonly rate: CurrencyRate | null;
  readonly note: string | null;
}

export function validateSettlementForm(
  raw: unknown,
  memberOrder: readonly string[],
): Validated<SettlementInput> {
  const parsed = settlementFormSchema.safeParse(raw);
  const errors = new ErrorCollector();
  if (!parsed.success) {
    errors.add("form", "The form data was not understood. Reload the page and try again.");
    return { ok: false, errors: errors.errors };
  }
  const form = parsed.data;
  const settledOn = readField(dateField, form.settledOn, "settledOn", errors);
  const currencyText = readField(currencyField, form.currency, "currency", errors);
  const note = readField(noteField, form.note, "note", errors);
  const currency = currencyText as CurrencyCode | undefined;

  if (!memberOrder.includes(form.fromUserId)) errors.add("fromUserId", "Pick who paid");
  if (!memberOrder.includes(form.toUserId)) errors.add("toUserId", "Pick who received it");
  if (form.fromUserId === form.toUserId && memberOrder.includes(form.fromUserId)) {
    errors.add("toUserId", "Pick two different people");
  }

  const amount = currency
    ? readPositiveAmount(form.amount, currency)
    : ({ ok: false, message: "Pick a currency first" } as const);
  if (!amount.ok && currency) errors.add("amount", amount.message);
  const { billed, rate } = currency
    ? readBilledAndRate({ currency, billed: form.billed, rate: form.rate }, errors)
    : { billed: null, rate: null };

  if (
    errors.hasErrors ||
    !amount.ok ||
    settledOn === undefined ||
    currency === undefined ||
    note === undefined
  ) {
    return { ok: false, errors: errors.errors };
  }
  return {
    ok: true,
    value: {
      fromUserId: form.fromUserId,
      toUserId: form.toUserId,
      settledOn,
      amountMinor: amount.minor,
      currency,
      billed,
      rate,
      note: note === "" ? null : note,
    },
  };
}
