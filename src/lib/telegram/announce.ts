import { formatMoney } from "@/lib/ledger/format";
import { isCurrencyCode } from "@/lib/money";
import { clip, escapeHtml, MESSAGE_LIMIT } from "./html";

/** The short messages the bot posts to the group and sends to members when the ledger changes. */

export interface ExpenseBrief {
  readonly id: string;
  readonly description: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly spentOn: string;
}

function money(minor: number, currency: string): string {
  return isCurrencyCode(currency) ? formatMoney(minor, currency) : `${String(minor)} ${currency}`;
}

function brief(expense: ExpenseBrief): string {
  return `${escapeHtml(clip(expense.description, 50))}, ${money(expense.amountMinor, expense.currency)}`;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

function totals(expenses: readonly ExpenseBrief[]): string {
  const byCurrency = new Map<string, number>();
  for (const e of expenses)
    byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amountMinor);
  return [...byCurrency].map(([currency, minor]) => money(minor, currency)).join(" + ");
}

export function announceImportConfirmed(actor: string, expenses: readonly ExpenseBrief[]): string {
  const shown = expenses.slice(0, 5).map(brief);
  const rest = expenses.length - shown.length;
  const list = shown.join("; ") + (rest > 0 ? `; and ${String(rest)} more` : "");
  return `<b>${escapeHtml(actor)}</b> added ${plural(expenses.length, "expense")} from a screenshot: ${totals(expenses)}\n${list}`;
}

export function announceExpenseAdded(actor: string, expense: ExpenseBrief, payers: string): string {
  return `<b>${escapeHtml(actor)}</b> added ${brief(expense)} (paid by ${escapeHtml(payers)}).`;
}

export function notifyExpenseEdited(
  actor: string,
  before: ExpenseBrief,
  after: ExpenseBrief,
  link: string,
): string {
  const changed =
    before.amountMinor !== after.amountMinor || before.currency !== after.currency
      ? `${money(before.amountMinor, before.currency)} is now ${money(after.amountMinor, after.currency)}`
      : "the details or the split changed";
  return `<b>${escapeHtml(actor)}</b> edited ${brief(after)} that you are part of: ${changed}.\n${link}`;
}

export function notifyExpenseDeleted(actor: string, expense: ExpenseBrief): string {
  return `<b>${escapeHtml(actor)}</b> deleted ${brief(expense)}, which you were part of.`;
}

export function notifyImportUndone(actor: string, expenses: readonly ExpenseBrief[]): string {
  const list = expenses.slice(0, 5).map(brief).join("; ");
  const text = `<b>${escapeHtml(actor)}</b> undid an import: ${plural(expenses.length, "expense")} removed (${totals(expenses)}).\n${list}`;
  return text.slice(0, MESSAGE_LIMIT);
}
