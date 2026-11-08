import { z } from "zod";
import { formatRate, isCurrencyCode, parseRate } from "@/lib/money";
import { categoryLabel, CATEGORY_IDS } from "./categories";
import { formatDate } from "./days";
import { SPLIT_MODES } from "./expense-form";
import { formatMoney } from "./format";
import type { StoredExpense, StoredSettlement } from "./types";

/** The actions written to `audit_log.action`. */
export const AUDIT_ACTIONS = [
  "expense.create",
  "expense.update",
  "expense.delete",
  "expense.restore",
  "settlement.create",
  "settlement.delete",
  "settlement.restore",
  "import.confirm",
  "import.undo",
  "import.cancel",
  "import.image_deleted",
  "expense.reprice",
  "settlement.reprice",
  "daily_rate.set",
  "daily_rate.clear",
  "daily_rate.reprice",
  "budget.set",
  "budget.clear",
  "trip.update",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const personAmount = z.object({
  userId: z.string(),
  amountMinor: z.number().int(),
  weight: z.number().int().nullable().optional(),
});

/** The JSON stored in `audit_log.before` and `.after` for an expense. */
export const expenseSnapshotSchema = z.object({
  description: z.string(),
  category: z.enum(CATEGORY_IDS),
  spentOn: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  billedAmountMinor: z.number().int().nullable(),
  billedCurrency: z.string().nullable(),
  rate: z.string().nullable(),
  rateCurrency: z.string().nullable(),
  pricedRate: z.string().nullable().optional(),
  pricedRateCurrency: z.string().nullable().optional(),
  pricedSource: z.enum(["day_override", "market"]).nullable().optional(),
  splitMethod: z.enum(SPLIT_MODES),
  payers: z.array(personAmount),
  shares: z.array(personAmount),
});
export type ExpenseSnapshot = z.infer<typeof expenseSnapshotSchema>;

export const settlementSnapshotSchema = z.object({
  fromUserId: z.string(),
  toUserId: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  billedAmountMinor: z.number().int().nullable(),
  billedCurrency: z.string().nullable(),
  rate: z.string().nullable(),
  rateCurrency: z.string().nullable(),
  settledOn: z.string(),
  note: z.string().nullable(),
});
export type SettlementSnapshot = z.infer<typeof settlementSnapshotSchema>;

/** How an expense's SGD figure was worked out at one moment; stored in the audit log when it is re-priced. */
export const pricingSnapshotSchema = z.object({
  sgdMinor: z.number().int(),
  source: z.enum(["native", "billed", "expense_rate", "day_override", "market"]),
  /** SGD per 1 unit of the converted currency; null when no rate was involved. */
  rate: z.string().nullable(),
});
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;

/** The JSON in `audit_log.before` and `.after` for an `expense.reprice` entry. */
export const repriceSnapshotSchema = z.object({
  description: z.string().optional(),
  spentOn: z.string().optional(),
  settledOn: z.string().optional(),
  pricing: pricingSnapshotSchema.nullable(),
});

const PRICING_SOURCE_LABELS: Record<PricingSnapshot["source"], string> = {
  native: "Already in SGD",
  billed: "Exact figure billed in SGD",
  expense_rate: "Your rate on the expense",
  day_override: "Day rate",
  market: "Market rate",
};

/** "S$222.74 (Day rate S$1.55)" or "No exchange rate". */
export function describePricing(pricing: PricingSnapshot | null): string {
  if (pricing === null) return "No exchange rate";
  const label = PRICING_SOURCE_LABELS[pricing.source];
  const rate = pricing.rate === null ? "" : ` S$${pricing.rate}`;
  return `${formatMoney(pricing.sgdMinor, "SGD")} (${label}${rate})`;
}

export function snapshotExpense(expense: StoredExpense): ExpenseSnapshot {
  return {
    description: expense.description,
    category: expense.category,
    spentOn: expense.spentOn,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    billedAmountMinor: expense.billedAmountMinor,
    billedCurrency: expense.billedCurrency,
    rate: expense.rate === null ? null : formatRate(parseRate(expense.rate)),
    rateCurrency: expense.rateCurrency,
    pricedRate: expense.pricedRate === null ? null : formatRate(parseRate(expense.pricedRate)),
    pricedRateCurrency: expense.pricedRateCurrency,
    pricedSource: expense.pricedSource,
    splitMethod: expense.splitMethod,
    payers: expense.payers.map((p) => ({ userId: p.userId, amountMinor: p.amountMinor })),
    shares: expense.shares.map((s) => ({
      userId: s.userId,
      amountMinor: s.amountMinor,
      weight: s.weight,
    })),
  };
}

export function snapshotSettlement(settlement: StoredSettlement): SettlementSnapshot {
  return {
    fromUserId: settlement.fromUserId,
    toUserId: settlement.toUserId,
    amountMinor: settlement.amountMinor,
    currency: settlement.currency,
    billedAmountMinor: settlement.billedAmountMinor,
    billedCurrency: settlement.billedCurrency,
    rate: settlement.rate === null ? null : formatRate(parseRate(settlement.rate)),
    rateCurrency: settlement.rateCurrency,
    settledOn: settlement.settledOn,
    note: settlement.note,
  };
}

/** One line of "who changed what": a field with its old and new value as people read them. */
export interface Change {
  readonly label: string;
  readonly from: string | null;
  readonly to: string | null;
}

function money(minor: number, currency: string): string {
  return isCurrencyCode(currency) ? formatMoney(minor, currency) : `${String(minor)} ${currency}`;
}

function people(
  rows: readonly { userId: string; amountMinor: number }[],
  currency: string,
  nameOf: (userId: string) => string,
): string {
  return rows.map((row) => `${nameOf(row.userId)} ${money(row.amountMinor, currency)}`).join(", ");
}

function byUserId<T extends { userId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

const SPLIT_LABELS: Record<(typeof SPLIT_MODES)[number], string> = {
  equal: "Equally",
  exact: "Exact amounts",
  percent: "By percentage",
  shares: "By shares",
};

/** The facts of an expense as labelled display text; the basis for comparing two versions. */
function expenseFacts(
  snapshot: ExpenseSnapshot,
  nameOf: (userId: string) => string,
): [label: string, value: string | null][] {
  return [
    ["Description", snapshot.description],
    ["Category", categoryLabel(snapshot.category)],
    ["Date", formatDate(snapshot.spentOn)],
    ["Amount", money(snapshot.amountMinor, snapshot.currency)],
    [
      "Billed by the bank",
      snapshot.billedAmountMinor !== null && snapshot.billedCurrency !== null
        ? money(snapshot.billedAmountMinor, snapshot.billedCurrency)
        : null,
    ],
    [
      "Exchange rate",
      snapshot.rate !== null && snapshot.rateCurrency !== null
        ? `S$${snapshot.rate} per ${snapshot.rateCurrency}`
        : null,
    ],
    [
      "Priced at",
      snapshot.pricedRate != null && snapshot.pricedRateCurrency != null && snapshot.pricedSource
        ? `S$${snapshot.pricedRate} per ${snapshot.pricedRateCurrency} (${PRICING_SOURCE_LABELS[snapshot.pricedSource]})`
        : null,
    ],
    ["Paid by", people(byUserId(snapshot.payers), snapshot.currency, nameOf)],
    ["Split", SPLIT_LABELS[snapshot.splitMethod]],
    ["Shared between", people(byUserId(snapshot.shares), snapshot.currency, nameOf)],
  ];
}

/** The fields that differ between two versions of an expense (all fields of one when the other is absent). */
export function describeExpenseChanges(
  before: ExpenseSnapshot | null,
  after: ExpenseSnapshot | null,
  nameOf: (userId: string) => string,
): Change[] {
  const reference = after ?? before;
  if (!reference) return [];
  const left = new Map(before ? expenseFacts(before, nameOf) : []);
  const right = new Map(after ? expenseFacts(after, nameOf) : []);
  const changes: Change[] = [];
  for (const [label] of expenseFacts(reference, nameOf)) {
    const from = left.get(label) ?? null;
    const to = right.get(label) ?? null;
    if (from !== to) changes.push({ label, from, to });
  }
  return changes;
}

export function auditActionLabel(action: string): string {
  switch (action) {
    case "expense.create":
      return "Added";
    case "expense.update":
      return "Edited";
    case "expense.delete":
      return "Deleted";
    case "expense.restore":
      return "Restored";
    case "settlement.create":
      return "Recorded a settlement";
    case "settlement.delete":
      return "Deleted a settlement";
    case "settlement.restore":
      return "Restored a settlement";
    case "import.confirm":
      return "Added from a screenshot";
    case "import.undo":
      return "Undid a screenshot import";
    case "import.cancel":
      return "Discarded a screenshot import";
    case "import.image_deleted":
      return "Deleted the original screenshot";
    case "expense.reprice":
      return "Re-priced";
    case "settlement.reprice":
      return "Re-priced a settlement";
    case "daily_rate.set":
      return "Set a day rate";
    case "daily_rate.clear":
      return "Cleared a day rate";
    case "daily_rate.reprice":
      return "Re-priced a day";
    case "budget.set":
      return "Set a budget";
    case "budget.clear":
      return "Cleared a budget";
    case "trip.update":
      return "Changed the trip";
    default:
      return action;
  }
}
