import { z } from "zod";
import {
  allocateSplit,
  FULL_BASIS_POINTS,
  MoneyError,
  sum,
  type BilledAmount,
  type CurrencyCode,
  type CurrencyRate,
  type IsoDate,
  type SplitSpec,
} from "@/lib/money";
import { CATEGORY_IDS, type CategoryId } from "./categories";
import {
  billedFormSchema,
  currencyField,
  dateField,
  descriptionField,
  ErrorCollector,
  rateFormSchema,
  readBilledAndRate,
  readPositiveAmount,
  readField,
  type Validated,
} from "./fields";
import { formatMoney } from "./format";

export const SPLIT_MODES = ["equal", "exact", "percent", "shares"] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

export const MAX_SHARES = 1000;

/** What the add and edit form submits: plain text and toggles, nothing parsed yet. */
export const expenseFormSchema = z.object({
  description: z.string(),
  spentOn: z.string(),
  category: z.string(),
  amount: z.string(),
  currency: z.string(),
  billed: billedFormSchema.nullable(),
  rate: rateFormSchema.nullable(),
  payers: z.array(z.object({ userId: z.string(), included: z.boolean(), amount: z.string() })),
  split: z.object({
    mode: z.enum(SPLIT_MODES),
    members: z.array(z.object({ userId: z.string(), included: z.boolean(), value: z.string() })),
  }),
});

export type ExpenseFormValues = z.infer<typeof expenseFormSchema>;

/** A fully validated expense: integer minor units, payers and shares that sum exactly. */
export interface ExpenseInput {
  readonly description: string;
  readonly category: CategoryId;
  readonly spentOn: IsoDate;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly billed: BilledAmount | null;
  readonly rate: CurrencyRate | null;
  readonly splitMethod: SplitMode;
  /** In the group's member order. Amounts add up to `amountMinor`. */
  readonly payers: readonly { userId: string; amountMinor: number }[];
  /** In the group's member order. Amounts add up to `amountMinor`. `weight` is basis points or share count. */
  readonly shares: readonly { userId: string; amountMinor: number; weight: number | null }[];
}

/** Reads a percentage such as "33.33" into basis points; at most two decimals. */
export function readBasisPoints(text: string): number | undefined {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return undefined;
  const [, whole = "0", fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function readShareCount(text: string): number | undefined {
  if (!/^\d{1,4}$/.test(text.trim())) return undefined;
  const count = Number(text.trim());
  return count >= 1 && count <= MAX_SHARES ? count : undefined;
}

/**
 * Validates the submitted form against the group's member order and computes the
 * payers and shares. Runs unchanged in the browser (live preview) and on the server
 * (the authority). Never throws for bad user input.
 */
export function validateExpenseForm(
  raw: unknown,
  memberOrder: readonly string[],
): Validated<ExpenseInput> {
  const parsed = expenseFormSchema.safeParse(raw);
  const errors = new ErrorCollector();
  if (!parsed.success) {
    errors.add("form", "The form data was not understood. Reload the page and try again.");
    return { ok: false, errors: errors.errors };
  }
  const form = parsed.data;
  const members = new Set(memberOrder);

  // Each field is checked on its own so one mistake never hides the others.
  const description = readField(descriptionField, form.description, "description", errors);
  const spentOn = readField(dateField, form.spentOn, "spentOn", errors);
  const category = readField(
    z.enum(CATEGORY_IDS, "Pick a category"),
    form.category,
    "category",
    errors,
  );
  const currencyText = readField(currencyField, form.currency, "currency", errors);
  const currency = currencyText as CurrencyCode | undefined;
  const mode = form.split.mode;

  const amount = currency
    ? readPositiveAmount(form.amount, currency)
    : ({ ok: false, message: "Pick a currency first" } as const);
  if (!amount.ok && currency) errors.add("amount", amount.message);
  const { billed, rate } = currency
    ? readBilledAndRate({ currency, billed: form.billed, rate: form.rate }, errors)
    : { billed: null, rate: null };

  const total = amount.ok ? amount.minor : undefined;
  const payers =
    total === undefined || !currency ? [] : readPayers(form, total, currency, members, errors);
  const splitErrors = new ErrorCollector();
  const split =
    total === undefined || !currency
      ? []
      : readSplit(form.split, total, currency, memberOrder, splitErrors);
  for (const [field, message] of Object.entries(splitErrors.errors)) errors.add(field, message);

  if (
    errors.hasErrors ||
    !amount.ok ||
    description === undefined ||
    spentOn === undefined ||
    category === undefined ||
    currency === undefined
  ) {
    return { ok: false, errors: errors.errors };
  }

  return {
    ok: true,
    value: {
      description,
      category,
      spentOn,
      amountMinor: amount.minor,
      currency,
      billed,
      rate,
      splitMethod: mode,
      payers: inOrder(payers, memberOrder),
      shares: inOrder(split, memberOrder),
    },
  };
}

function inOrder<T extends { userId: string }>(rows: readonly T[], order: readonly string[]): T[] {
  const position = new Map(order.map((id, index) => [id, index] as const));
  return [...rows].sort((a, b) => (position.get(a.userId) ?? 0) - (position.get(b.userId) ?? 0));
}

function readPayers(
  form: ExpenseFormValues,
  total: number,
  currency: CurrencyCode,
  members: ReadonlySet<string>,
  errors: ErrorCollector,
): { userId: string; amountMinor: number }[] {
  const included = form.payers.filter((payer) => payer.included);
  if (included.length === 0) {
    errors.add("payers", "Pick who paid");
    return [];
  }
  const ids = included.map((payer) => payer.userId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !members.has(id))) {
    errors.add("payers", "Someone who is not in this group is listed as a payer");
    return [];
  }
  const [only, ...others] = included;
  if (only && others.length === 0) return [{ userId: only.userId, amountMinor: total }];

  const rows: { userId: string; amountMinor: number }[] = [];
  for (const payer of included) {
    const amount = readPositiveAmount(payer.amount, currency);
    if (amount.ok) rows.push({ userId: payer.userId, amountMinor: amount.minor });
    else errors.add(`payers.${payer.userId}`, amount.message);
  }
  if (rows.length === included.length) {
    const paid = sum(rows.map((row) => row.amountMinor));
    if (paid !== total) {
      errors.add(
        "payers",
        `Payments add up to ${formatMoney(paid, currency)}, but the expense is ${formatMoney(total, currency)}`,
      );
    }
  }
  return rows;
}

/** Computes each person's share for the live preview; undefined while the split is incomplete. */
export function previewShares(
  split: ExpenseFormValues["split"],
  total: number,
  currency: CurrencyCode,
  memberOrder: readonly string[],
): { userId: string; amountMinor: number; weight: number | null }[] | undefined {
  const errors = new ErrorCollector();
  const shares = readSplit(split, total, currency, memberOrder, errors);
  return errors.hasErrors ? undefined : shares;
}

function readSplit(
  split: ExpenseFormValues["split"],
  total: number,
  currency: CurrencyCode,
  memberOrder: readonly string[],
  errors: ErrorCollector,
): { userId: string; amountMinor: number; weight: number | null }[] {
  const members = new Set(memberOrder);
  const included = split.members.filter((member) => member.included);
  if (included.length === 0) {
    errors.add("split", "Pick at least one person to share this with");
    return [];
  }
  const ids = included.map((member) => member.userId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !members.has(id))) {
    errors.add("split", "Someone who is not in this group is part of the split");
    return [];
  }

  let weights: { userId: string; value: number; weight: number | null }[] = [];
  let spec: SplitSpec;
  switch (split.mode) {
    case "equal":
      spec = { kind: "equal", members: ids };
      break;
    case "exact": {
      weights = readEach(included, errors, (member) => {
        const amount = readPositiveAmount(member.value, currency);
        return amount.ok ? { value: amount.minor, weight: null } : amount.message;
      });
      spec = {
        kind: "exact",
        entries: weights.map((entry) => ({ memberId: entry.userId, minor: entry.value })),
      };
      if (weights.length === included.length) {
        const entered = sum(weights.map((entry) => entry.value));
        if (entered !== total) {
          errors.add(
            "split",
            `Amounts add up to ${formatMoney(entered, currency)}, but the expense is ${formatMoney(total, currency)}`,
          );
        }
      }
      break;
    }
    case "percent": {
      weights = readEach(included, errors, (member) => {
        const basisPoints = readBasisPoints(member.value);
        if (basisPoints === undefined || basisPoints <= 0 || basisPoints > FULL_BASIS_POINTS) {
          return "Enter a percentage like 33.33";
        }
        return { value: basisPoints, weight: basisPoints };
      });
      spec = {
        kind: "percent",
        entries: weights.map((entry) => ({ memberId: entry.userId, basisPoints: entry.value })),
      };
      if (weights.length === included.length) {
        const entered = sum(weights.map((entry) => entry.value));
        if (entered !== FULL_BASIS_POINTS) {
          errors.add("split", `Percentages add up to ${percentText(entered)}, not 100%`);
        }
      }
      break;
    }
    case "shares": {
      weights = readEach(included, errors, (member) => {
        const count = readShareCount(member.value);
        return count === undefined
          ? `Enter a whole number from 1 to ${String(MAX_SHARES)}`
          : { value: count, weight: count };
      });
      spec = {
        kind: "shares",
        entries: weights.map((entry) => ({ memberId: entry.userId, shares: entry.value })),
      };
      break;
    }
  }

  // Per-person problems (or a total that does not add up) are already reported.
  if (errors.hasErrors) return [];
  try {
    const allocation = allocateSplit(total, spec, memberOrder);
    const weightOf = new Map(weights.map((entry) => [entry.userId, entry.weight] as const));
    return allocation.map((entry) => ({
      userId: entry.memberId,
      amountMinor: entry.minor,
      weight: weightOf.get(entry.memberId) ?? null,
    }));
  } catch (error) {
    if (error instanceof MoneyError) {
      errors.add("split", error.message);
      return [];
    }
    throw error;
  }
}

function percentText(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, "0");
  return `${String(whole)}.${fraction}%`;
}

function readEach(
  members: readonly { userId: string; value: string }[],
  errors: ErrorCollector,
  read: (member: {
    userId: string;
    value: string;
  }) => string | { value: number; weight: number | null },
): { userId: string; value: number; weight: number | null }[] {
  const rows: { userId: string; value: number; weight: number | null }[] = [];
  for (const member of members) {
    const result = read(member);
    if (typeof result === "string") errors.add(`split.${member.userId}`, result);
    else rows.push({ userId: member.userId, ...result });
  }
  return rows;
}

/** Splits a total evenly in basis points for the "Even" button: 3 people get 3334, 3333, 3333. */
export function evenBasisPoints(count: number): number[] {
  const base = Math.trunc(FULL_BASIS_POINTS / count);
  const extra = FULL_BASIS_POINTS - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

export function isSplitMode(value: unknown): value is SplitMode {
  return SPLIT_MODES.some((mode) => mode === value);
}
