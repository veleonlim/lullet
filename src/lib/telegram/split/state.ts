import { z } from "zod";
import { CATEGORY_IDS, type CategoryId } from "@/lib/ledger/categories";
import {
  validateExpenseForm,
  type ExpenseFormValues,
  type ExpenseInput,
  type SplitMode,
} from "@/lib/ledger/expense-form";
import type { FieldErrors } from "@/lib/ledger/fields";
import { formatBasisPoints, formatPlainAmount } from "@/lib/ledger/format";
import { isCurrencyCode, type CurrencyCode } from "@/lib/money";

/**
 * The answers collected by the /split conversation, and the rules for moving from one question to
 * the next. All pure: the bot stores `SplitState` in the database between messages, and the
 * finished answers become the same form values the web form submits, so one validator
 * (`validateExpenseForm`) decides what a valid expense is.
 */

/** The questions, in the order they are asked. */
export const SPLIT_STEPS = [
  "title",
  "amount",
  "payers",
  "payer_amounts",
  "sharers",
  "method",
  "values",
  "date",
  "category",
  "summary",
  /** The Edit screen: a list of answers to change. Not part of a straight run. */
  "menu",
] as const;
export type SplitStep = (typeof SPLIT_STEPS)[number];

export function isSplitStep(value: unknown): value is SplitStep {
  return SPLIT_STEPS.some((step) => step === value);
}

/** The ways to split offered in chat. (The web form also has shares.) */
export const SPLIT_METHODS = ["equal", "percent", "exact"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

/** Currencies with a button; any other supported code can still be typed ("100 GBP"). */
export const CURRENCY_BUTTONS = ["SGD", "EUR", "CHF"] as const satisfies readonly CurrencyCode[];

/** The currency a bare number is read in until the person says otherwise. */
export const DEFAULT_CURRENCY: CurrencyCode = "SGD";

/** Same as the web form's blank expense. */
export const DEFAULT_CATEGORY: CategoryId = "food";

export const splitStateSchema = z.object({
  /** Set while one answer is being changed from the summary; finishing it goes back there. */
  editing: z.boolean(),
  title: z.string().nullable(),
  /** The currency of a bare number, then the currency of the expense. */
  currency: z.string().refine((value): boolean => isCurrencyCode(value)),
  amountMinor: z.number().int().positive().nullable(),
  /** User ids, any order; the group's order is applied when the expense is built. */
  payers: z.array(z.string()),
  /** What each payer paid in minor units; only asked with two or more payers. */
  payerAmounts: z.record(z.string(), z.number().int().positive()).nullable(),
  sharers: z.array(z.string()),
  method: z.enum(SPLIT_METHODS),
  /** Basis points for percent, minor units for exact; only asked for those methods. */
  values: z.record(z.string(), z.number().int().positive()).nullable(),
  date: z.string().nullable(),
  category: z.enum(CATEGORY_IDS),
});
export type SplitState = Omit<z.infer<typeof splitStateSchema>, "currency"> & {
  currency: CurrencyCode;
};

export function readSplitState(raw: unknown): SplitState | null {
  const parsed = splitStateSchema.safeParse(raw);
  // The refinement above guarantees a supported code, which zod cannot express as a type.
  return parsed.success ? (parsed.data as SplitState) : null;
}

/** A new flow: the sender paid, everyone shares equally, today, food. */
export function initialSplitState(input: {
  readonly userId: string;
  readonly memberIds: readonly string[];
}): SplitState {
  return {
    editing: false,
    title: null,
    currency: DEFAULT_CURRENCY,
    amountMinor: null,
    payers: [input.userId],
    payerAmounts: null,
    sharers: [...input.memberIds],
    method: "equal",
    values: null,
    date: null,
    category: DEFAULT_CATEGORY,
  };
}

/** Whether a currency code from the supported list is one of the three buttons. */
export function isButtonCurrency(code: string): boolean {
  return (CURRENCY_BUTTONS as readonly string[]).includes(code);
}

/** Whether a question applies given the answers so far. */
export function applies(state: SplitState, step: SplitStep): boolean {
  switch (step) {
    case "payer_amounts":
      return state.payers.length > 1;
    case "method":
      return state.sharers.length > 1;
    case "values":
      return state.sharers.length > 1 && state.method !== "equal";
    default:
      return true;
  }
}

/** An answer that is needed and not given yet, beyond the ones asked in a straight run. */
function missing(state: SplitState): SplitStep | null {
  if (applies(state, "payer_amounts") && state.payerAmounts === null) return "payer_amounts";
  if (applies(state, "values") && state.values === null) return "values";
  return null;
}

/**
 * The question after `done`. In a straight run it is the next one that applies; while changing one
 * answer it is whatever that change left unanswered, else the summary.
 */
export function stepAfter(state: SplitState, done: SplitStep): SplitStep {
  if (state.editing) return missing(state) ?? "summary";
  const from = SPLIT_STEPS.indexOf(done);
  for (const step of SPLIT_STEPS.slice(from + 1)) {
    if (applies(state, step)) return step;
  }
  return "summary";
}

/** Entering a question from the edit menu; the rest of the flow is skipped on the way back. */
export function startEditing(state: SplitState): SplitState {
  return { ...state, editing: true };
}

// ---- answers --------------------------------------------------------------------------------

export function withTitle(state: SplitState, title: string): SplitState {
  return { ...state, title };
}

/** A new total makes the amounts typed against the old one meaningless; percentages still hold. */
export function withAmount(
  state: SplitState,
  amountMinor: number,
  currency: CurrencyCode,
): SplitState {
  const changed = state.amountMinor !== amountMinor || state.currency !== currency;
  return {
    ...state,
    amountMinor,
    currency,
    payerAmounts: changed ? null : state.payerAmounts,
    values: changed && state.method === "exact" ? null : state.values,
  };
}

/** Who paid changed, so the amounts typed for the old payers no longer apply. */
export function withPayers(state: SplitState, payers: readonly string[]): SplitState {
  return { ...state, payers: [...payers], payerAmounts: null };
}

export function withPayerAmounts(
  state: SplitState,
  payerAmounts: Readonly<Record<string, number>>,
): SplitState {
  return { ...state, payerAmounts: { ...payerAmounts } };
}

/** Who shared changed, so the percentages or amounts typed for the old group no longer apply. */
export function withSharers(state: SplitState, sharers: readonly string[]): SplitState {
  // One person cannot be "split" with anyone: that is an equal share of one.
  const method: SplitMethod = sharers.length < 2 ? "equal" : state.method;
  return { ...state, sharers: [...sharers], method, values: null };
}

export function withMethod(state: SplitState, method: SplitMethod): SplitState {
  return { ...state, method, values: method === state.method ? state.values : null };
}

export function withValues(
  state: SplitState,
  values: Readonly<Record<string, number>>,
): SplitState {
  return { ...state, values: { ...values } };
}

export function withDate(state: SplitState, date: string): SplitState {
  return { ...state, date };
}

export function withCategory(state: SplitState, category: CategoryId): SplitState {
  return { ...state, category };
}

/** Adds the person, or removes them when they are already in the list. */
export function toggled(list: readonly string[], userId: string): string[] {
  return list.includes(userId) ? list.filter((id) => id !== userId) : [...list, userId];
}

// ---- the expense ----------------------------------------------------------------------------

/**
 * The answers as the web form's values, with stand-ins for anything not answered yet (`today`
 * for the date), so the same validator can check the answers given so far.
 */
export function toFormValues(
  state: SplitState,
  input: { readonly memberIds: readonly string[]; readonly today: string },
): ExpenseFormValues {
  const { currency } = state;
  const amount = (minor: number | undefined) =>
    minor === undefined ? "" : formatPlainAmount(minor, currency);
  const multiple = state.payers.length > 1;
  const mode: SplitMode = state.sharers.length < 2 ? "equal" : state.method;
  const value = (userId: string): string => {
    const stored = state.values?.[userId];
    if (stored === undefined) return "";
    return mode === "percent" ? formatBasisPoints(stored) : amount(stored);
  };
  return {
    description: state.title ?? "",
    spentOn: state.date ?? input.today,
    category: state.category,
    amount: state.amountMinor === null ? "" : amount(state.amountMinor),
    currency,
    billed: null,
    rate: null,
    payers: input.memberIds.map((userId) => ({
      userId,
      included: state.payers.includes(userId),
      amount: multiple ? amount(state.payerAmounts?.[userId]) : "",
    })),
    split: {
      mode,
      members: input.memberIds.map((userId) => ({
        userId,
        included: state.sharers.includes(userId),
        value: mode === "equal" ? "" : value(userId),
      })),
    },
  };
}

export type SplitCheck =
  | { readonly ok: true; readonly expense: ExpenseInput }
  | { readonly ok: false; readonly errors: FieldErrors };

/** Runs the web form's validator over the answers. */
export function checkSplit(
  state: SplitState,
  input: { readonly memberIds: readonly string[]; readonly today: string },
): SplitCheck {
  const checked = validateExpenseForm(toFormValues(state, input), input.memberIds);
  return checked.ok ? { ok: true, expense: checked.value } : { ok: false, errors: checked.errors };
}

/** The first message about the given fields (`payers`, `split`, ...), or null when they are fine. */
export function errorFor(errors: FieldErrors, ...prefixes: readonly string[]): string | null {
  for (const [field, message] of Object.entries(errors)) {
    if (prefixes.some((prefix) => field === prefix || field.startsWith(`${prefix}.`))) {
      return message;
    }
  }
  return null;
}
