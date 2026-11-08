import { z } from "zod";
import { CATEGORY_IDS, isCategoryId, type CategoryId } from "@/lib/ledger/categories";
import type { ExpenseInput } from "@/lib/ledger/expense-form";
import { MAX_DESCRIPTION_LENGTH, readPositiveAmount, type FieldErrors } from "@/lib/ledger/fields";
import { formatPlainAmount } from "@/lib/ledger/format";
import { isCurrencyCode, isIsoDate, REPORTING_CURRENCY, type CurrencyCode } from "@/lib/money";
import { MAX_TRANSACTIONS } from "./extraction";
import type { DraftRowSeed, FieldStates } from "./normalize";
import { isBlocking } from "./normalize";
import {
  allocateRow,
  batchSplitSchema,
  resolveSplit,
  rowSplitOverrideSchema,
  type BatchSplit,
  type RowSplitOverride,
} from "./split";

/** What a draft row points at when it looks like something already recorded. */
export interface DuplicateRef {
  readonly kind: "expense" | "draft";
  readonly id: string;
  readonly importId: string | null;
  /** Shown to the person: the existing record's description and day. */
  readonly label: string;
}

/** A draft row as stored: what was read, plus the person's edits and choices. */
export interface DraftRow extends DraftRowSeed {
  readonly id: string;
  readonly position: number;
  readonly duplicateOf: DuplicateRef | null;
  /** Null when the row simply follows the batch. */
  readonly split: RowSplitOverride | null;
}

/** One row as the review screen edits it: plain text and choices, nothing parsed yet. */
export const rowEditSchema = z.object({
  id: z.string().max(64),
  included: z.boolean(),
  merchant: z.string().max(300),
  date: z.string().max(20),
  amount: z.string().max(40),
  currency: z.string().max(8),
  billedAmount: z.string().max(40),
  billedCurrency: z.string().max(8),
  category: z.string().max(20),
  split: rowSplitOverrideSchema.nullable(),
});
export type RowEdit = z.infer<typeof rowEditSchema>;

export const draftEditSchema = z.object({
  batch: batchSplitSchema,
  rows: z.array(rowEditSchema).max(MAX_TRANSACTIONS + 20),
});
export type DraftEdit = z.infer<typeof draftEditSchema>;

/** The review screen's starting point for a stored row. */
export function rowToEdit(row: DraftRow): RowEdit {
  return {
    id: row.id,
    included: row.included,
    merchant: row.merchant ?? "",
    date: row.spentOn ?? "",
    amount:
      row.amountMinor !== null && row.currency !== null
        ? formatPlainAmount(row.amountMinor, row.currency)
        : (row.amountText ?? ""),
    currency: row.currency ?? "",
    billedAmount:
      row.billedAmountMinor !== null && row.billedCurrency !== null
        ? formatPlainAmount(row.billedAmountMinor, row.billedCurrency)
        : "",
    billedCurrency: row.billedCurrency ?? "",
    category: row.category,
    split: row.split,
  };
}

/** The currency the charged amount is in: a figure typed with no currency picked is SGD. */
export function chargedCurrency(edit: Pick<RowEdit, "billedAmount" | "billedCurrency">): string {
  return edit.billedCurrency === "" && edit.billedAmount.trim() !== ""
    ? REPORTING_CURRENCY
    : edit.billedCurrency;
}

function withState(
  states: FieldStates,
  field: keyof FieldStates,
  value: FieldStates[typeof field],
) {
  return { ...states, [field]: value };
}

/**
 * Applies an edit to a stored row. Nothing is rejected here (a person may be half way through
 * typing): what does not parse is stored as missing and shown as "needs input". A field the
 * person changed counts as read by a human, so its doubt is cleared; an untouched field keeps it.
 */
export function applyEdit(row: DraftRow, edit: RowEdit): DraftRow {
  let states: FieldStates = row.fieldStates;

  const merchantText = edit.merchant.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const merchant = merchantText === "" ? null : merchantText;
  if (merchant !== row.merchant) {
    states = withState(states, "merchant", merchant === null ? "unreadable" : "clear");
  }

  const date =
    isIsoDate(edit.date) && edit.date >= "2000-01-01" && edit.date <= "2100-12-31"
      ? edit.date
      : null;
  if (date !== row.spentOn)
    states = withState(states, "date", date === null ? "unreadable" : "clear");

  const currency: CurrencyCode | null = isCurrencyCode(edit.currency) ? edit.currency : null;
  if (currency !== row.currency) {
    states = withState(states, "currency", currency === null ? "unreadable" : "clear");
  }

  const amountText = edit.amount.trim();
  let amountMinor: number | null = null;
  if (currency !== null) {
    const amount = readPositiveAmount(amountText, currency);
    if (amount.ok) amountMinor = amount.minor;
  }
  // An amount that does not parse needs input; one a person changed to a valid value is clear.
  if (amountMinor === null) states = withState(states, "amount", "unreadable");
  else if (amountMinor !== row.amountMinor) states = withState(states, "amount", "clear");

  const chargedIn = chargedCurrency(edit);
  const billedCurrency: CurrencyCode | null = isCurrencyCode(chargedIn) ? chargedIn : null;
  let billedAmountMinor: number | null = null;
  if (billedCurrency !== null && edit.billedAmount.trim() !== "") {
    const billed = readPositiveAmount(edit.billedAmount, billedCurrency);
    if (billed.ok) billedAmountMinor = billed.minor;
  }
  const hasBilled = billedAmountMinor !== null && billedCurrency !== null;

  const category: CategoryId = isCategoryId(edit.category) ? edit.category : row.category;
  if (category !== row.category) states = withState(states, "category", "clear");

  return {
    ...row,
    merchant,
    spentOn: date,
    amountText: amountText === "" ? row.amountText : amountText,
    amountMinor,
    currency,
    billedAmountText: hasBilled ? edit.billedAmount.trim() : null,
    billedAmountMinor: hasBilled ? billedAmountMinor : null,
    billedCurrency: hasBilled ? billedCurrency : null,
    category,
    included: edit.included,
    fieldStates: states,
    split: edit.split,
  };
}

/** The payers kept to real members in the group's order; falls back to `fallback` if none is left. */
export function cleanBatch(
  batch: BatchSplit,
  order: readonly string[],
  fallback: string,
): BatchSplit {
  const payers = order.filter((id) => batch.payerIds.includes(id));
  const payerIds = payers.length > 0 ? payers : [fallback];
  const percents = batch.percents
    ? Object.fromEntries(Object.entries(batch.percents).filter(([id]) => order.includes(id)))
    : null;
  return {
    ...batch,
    payerIds,
    percents: percents && Object.keys(percents).length > 0 ? percents : null,
  };
}

export interface ConfirmRow {
  readonly row: DraftRow;
  readonly input: ExpenseInput;
}

export type DraftValidation =
  | { readonly ok: true; readonly rows: readonly ConfirmRow[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly errors: Readonly<Record<string, FieldErrors>>;
    };

/**
 * Checks everything Confirm needs: at least one row is going in, and every row going in has a
 * merchant, day, amount, currency and a split that adds up. Unchecked rows are not looked at.
 */
export function validateForConfirm(
  rows: readonly DraftRow[],
  batch: BatchSplit,
  order: readonly string[],
): DraftValidation {
  const going = rows.filter((row) => row.included);
  if (going.length === 0) {
    return { ok: false, message: "Tick at least one row to add", errors: {} };
  }
  const errors: Record<string, FieldErrors> = {};
  const accepted: ConfirmRow[] = [];

  for (const row of going) {
    const problems: Record<string, string> = {};
    if (row.merchant === null) problems.merchant = "Add a description";
    if (row.spentOn === null) problems.date = "Pick a valid date";
    if (row.currency === null) problems.currency = "Pick the currency";
    if (row.amountMinor === null) problems.amount = "Enter an amount like 48.50";
    if (isBlocking(row.fieldStates) && Object.keys(problems).length === 0) {
      // Every blocking field is filled in by now only if a person edited it; this is a safety net.
      problems.form = "Fill in the missing details";
    }

    const split = resolveSplit(batch, row.split, order);
    if (!split.ok) problems.split = split.message;

    if (
      Object.keys(problems).length > 0 ||
      !split.ok ||
      row.merchant === null ||
      row.spentOn === null ||
      row.currency === null ||
      row.amountMinor === null
    ) {
      errors[row.id] = problems;
      continue;
    }

    const allocation = allocateRow(row.amountMinor, split.split, batch.payerIds, order);
    accepted.push({
      row,
      input: {
        description: row.merchant,
        category: CATEGORY_IDS.includes(row.category) ? row.category : "other",
        spentOn: row.spentOn,
        amountMinor: row.amountMinor,
        currency: row.currency,
        billed:
          row.billedAmountMinor !== null && row.billedCurrency !== null
            ? { amountMinor: row.billedAmountMinor, currency: row.billedCurrency }
            : null,
        rate: null,
        splitMethod: allocation.splitMethod,
        payers: allocation.payers,
        shares: allocation.shares,
      },
    });
  }

  if (Object.keys(errors).length > 0) {
    const count = Object.keys(errors).length;
    return {
      ok: false,
      message:
        count === 1
          ? "One row needs attention before it can be added"
          : `${String(count)} rows need attention before they can be added`,
      errors,
    };
  }
  return { ok: true, rows: accepted };
}
