import {
  assertCurrencyCode,
  formatRate,
  parseRate,
  REPORTING_CURRENCY,
  type CurrencyCode,
} from "@/lib/money";
import type { ExpenseFormValues } from "./expense-form";
import type { SettlementFormValues } from "./settlement-form";
import { formatBasisPoints, formatPlainAmount } from "./format";
import type { Member, StoredExpense } from "./types";

/** The currency a new expense starts with: the trip's most likely first currency. */
export const DEFAULT_CURRENCY: CurrencyCode = "EUR";

/** Currencies offered first in pickers; the rest follow alphabetically. */
export const PREFERRED_CURRENCIES: readonly CurrencyCode[] = ["EUR", "CHF", REPORTING_CURRENCY];

/** A blank expense form: the signed-in member paid it all and everyone shares it equally. */
export function blankExpenseForm(input: {
  members: readonly Member[];
  payerUserId: string;
  today: string;
}): ExpenseFormValues {
  return {
    description: "",
    spentOn: input.today,
    category: "food",
    amount: "",
    currency: DEFAULT_CURRENCY,
    billed: null,
    rate: null,
    payers: input.members.map((member) => ({
      userId: member.userId,
      included: member.userId === input.payerUserId,
      amount: "",
    })),
    split: {
      mode: "equal",
      members: input.members.map((member) => ({
        userId: member.userId,
        included: true,
        value: "",
      })),
    },
  };
}

/** Fills the form from a stored expense, so an edit starts from exactly what was saved. */
export function expenseToFormValues(
  expense: StoredExpense,
  members: readonly Member[],
): ExpenseFormValues {
  const currency = assertCurrencyCode(expense.currency);
  const payer = new Map(expense.payers.map((p) => [p.userId, p] as const));
  const share = new Map(expense.shares.map((s) => [s.userId, s] as const));

  const valueFor = (userId: string): string => {
    const row = share.get(userId);
    if (!row) return "";
    switch (expense.splitMethod) {
      case "exact":
        return formatPlainAmount(row.amountMinor, currency);
      case "percent":
        return row.weight === null ? "" : formatBasisPoints(row.weight);
      case "shares":
        return row.weight === null ? "" : String(row.weight);
      case "equal":
        return "";
    }
  };

  return {
    description: expense.description,
    spentOn: expense.spentOn,
    category: expense.category,
    amount: formatPlainAmount(expense.amountMinor, currency),
    currency,
    billed:
      expense.billedAmountMinor !== null && expense.billedCurrency !== null
        ? {
            amount: formatPlainAmount(
              expense.billedAmountMinor,
              assertCurrencyCode(expense.billedCurrency),
            ),
            currency: expense.billedCurrency,
          }
        : null,
    rate:
      expense.rate !== null && expense.rateCurrency !== null
        ? { rate: formatRate(parseRate(expense.rate)), currency: expense.rateCurrency }
        : null,
    payers: members.map((member) => {
      const row = payer.get(member.userId);
      return {
        userId: member.userId,
        included: row !== undefined,
        amount: row ? formatPlainAmount(row.amountMinor, currency) : "",
      };
    }),
    split: {
      mode: expense.splitMethod,
      members: members.map((member) => ({
        userId: member.userId,
        included: share.has(member.userId),
        value: valueFor(member.userId),
      })),
    },
  };
}

export function blankSettlementForm(input: {
  fromUserId: string;
  toUserId: string;
  amount?: string;
  today: string;
}): SettlementFormValues {
  return {
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    settledOn: input.today,
    amount: input.amount ?? "",
    currency: REPORTING_CURRENCY,
    billed: null,
    rate: null,
    note: "",
  };
}
