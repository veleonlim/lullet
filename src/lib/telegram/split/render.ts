import type { InlineKeyboardButton } from "grammy/types";
import { CATEGORIES, categoryLabel } from "@/lib/ledger/categories";
import { formatDay } from "@/lib/ledger/days";
import type { ExpenseInput, SplitMode } from "@/lib/ledger/expense-form";
import { formatBasisPoints, formatMoney } from "@/lib/ledger/format";
import { clip, escapeHtml } from "@/lib/telegram/html";
import type { Person, RenderedMessage } from "@/lib/telegram/render";
import { encodeSplitCallback, type EditField, type SplitAction } from "./callbacks";
import { applies, CURRENCY_BUTTONS, type SplitState, type SplitStep } from "./state";

/**
 * The /split questions as Telegram messages: HTML text and inline buttons. Pure functions of the
 * answers so far, so every screen is tested without a bot. A question that has been answered is
 * rewritten as a one line recap (`recap`) and the next question is sent below it, so the chat
 * reads like the conversation it is.
 */

export interface SplitScreenInput {
  readonly flowId: string;
  readonly secret: string;
  readonly state: SplitState;
  /** In the group's fixed member order; the member buttons index into this list. */
  readonly members: readonly Person[];
}

const BUTTON_NAME_MAX = 12;

function nameOf(members: readonly Person[], userId: string): string {
  return members.find((member) => member.userId === userId)?.displayName ?? "Someone";
}

function namesOf(members: readonly Person[], ids: readonly string[]): string {
  return members
    .filter((member) => ids.includes(member.userId))
    .map((member) => escapeHtml(member.displayName))
    .join(", ");
}

/** The people in `ids`, in the group's order: the order amounts and percentages are typed in. */
export function inGroupOrder(members: readonly Person[], ids: readonly string[]): string[] {
  return members.filter((member) => ids.includes(member.userId)).map((member) => member.userId);
}

function button(input: SplitScreenInput, text: string, action: SplitAction): InlineKeyboardButton {
  return { text, callback_data: encodeSplitCallback(input.secret, input.flowId, action) };
}

function rows<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function cancelRow(input: SplitScreenInput): InlineKeyboardButton[] {
  return [button(input, "Cancel", { kind: "cancel" })];
}

function money(state: SplitState, minor: number): string {
  return formatMoney(minor, state.currency);
}

function methodName(method: SplitMode): string {
  switch (method) {
    case "percent":
      return "by percent";
    case "exact":
      return "by exact amounts";
    case "shares":
      return "by shares";
    case "equal":
      return "equally";
  }
}

// ---- the questions --------------------------------------------------------------------------

export function renderQuestion(input: SplitScreenInput, step: SplitStep): RenderedMessage {
  const { state, members } = input;
  const total = state.amountMinor === null ? "" : money(state, state.amountMinor);
  switch (step) {
    case "title":
      return {
        text: "<b>New expense</b>\nWhat was it for? For example <i>Dinner at Luigi's</i>.",
        keyboard: [cancelRow(input)],
      };
    case "amount":
      return {
        text: [
          "How much was it?",
          `Type an amount like <code>45</code>, <code>S$45</code> or <code>100 EUR</code>. A plain number is in ${state.currency}.`,
        ].join("\n"),
        keyboard: [
          CURRENCY_BUTTONS.map((code, index) =>
            button(input, code === state.currency ? `✓ ${code}` : code, {
              kind: "currency",
              index,
            }),
          ),
          cancelRow(input),
        ],
      };
    case "payers":
      return {
        text: "Who paid? Tap to choose, then Done. If more than one person paid, I will ask how much each paid.",
        keyboard: [
          ...rows(
            members.map((member, index) =>
              button(
                input,
                `${state.payers.includes(member.userId) ? "✓ " : ""}${clip(member.displayName, BUTTON_NAME_MAX)}`,
                { kind: "payer", member: index },
              ),
            ),
            2,
          ),
          [button(input, "Done", { kind: "payers_done" }), ...cancelRow(input)],
        ],
      };
    case "payer_amounts": {
      const order = inGroupOrder(members, state.payers);
      return {
        text: [
          `How much did each person pay? The total is ${total}.`,
          `Type the amounts in this order: ${namesOf(members, order)}. For example <code>${example(order.length, "amount")}</code>.`,
        ].join("\n"),
        keyboard: [[button(input, "Paid equally", { kind: "payers_equal" }), ...cancelRow(input)]],
      };
    }
    case "sharers":
      return {
        text: "Who shared it? Tap to choose, then Done.",
        keyboard: [
          ...rows(
            members.map((member, index) =>
              button(
                input,
                `${state.sharers.includes(member.userId) ? "✓ " : ""}${clip(member.displayName, BUTTON_NAME_MAX)}`,
                { kind: "sharer", member: index },
              ),
            ),
            2,
          ),
          [button(input, "Done", { kind: "sharers_done" }), ...cancelRow(input)],
        ],
      };
    case "method":
      return {
        text: "How should it be split?",
        keyboard: [
          [
            button(input, "Equally", { kind: "method", method: "equal" }),
            button(input, "By percent", { kind: "method", method: "percent" }),
            button(input, "Exact amounts", { kind: "method", method: "exact" }),
          ],
          cancelRow(input),
        ],
      };
    case "values": {
      const order = inGroupOrder(members, state.sharers);
      const percent = state.method === "percent";
      return {
        text: [
          percent
            ? "What percent does each person pay? They must add up to 100."
            : `How much does each person owe? They must add up to ${total}.`,
          `Type them in this order: ${namesOf(members, order)}. For example <code>${example(order.length, percent ? "percent" : "amount")}</code>.`,
        ].join("\n"),
        keyboard: [cancelRow(input)],
      };
    }
    case "date":
      return {
        text: "When was it? Tap a button or type a date like <code>2026-11-08</code>, <code>8/11</code> or <code>8 Nov</code>.",
        keyboard: [
          [
            button(input, "Today", { kind: "day", day: "today" }),
            button(input, "Yesterday", { kind: "day", day: "yesterday" }),
          ],
          cancelRow(input),
        ],
      };
    case "category":
      return {
        text: `Pick a category, or skip to keep ${categoryLabel(state.category)}.`,
        keyboard: [
          ...rows(
            CATEGORIES.map((category, index) =>
              button(input, category.label, { kind: "category", index }),
            ),
            3,
          ),
          [
            button(input, `Skip (${categoryLabel(state.category)})`, { kind: "category_skip" }),
            ...cancelRow(input),
          ],
        ],
      };
    case "summary":
    case "menu":
      throw new Error("the summary and the edit menu have their own renderers");
  }
}

/** A made up answer in the shape asked for, so the example always matches how many people there are. */
function example(count: number, kind: "amount" | "percent"): string {
  const parts = Array.from({ length: count }, (_, i) => {
    if (kind === "percent")
      return String(count === 2 ? (i === 0 ? 60 : 40) : Math.floor(100 / count));
    return String(10 * (i + 1));
  });
  return parts.join(" ");
}

// ---- recaps ---------------------------------------------------------------------------------

/** The line an answered question is rewritten to; null for steps that leave no line. */
export function renderRecap(input: SplitScreenInput, step: SplitStep): string | null {
  const { state, members } = input;
  const total = state.amountMinor === null ? "" : money(state, state.amountMinor);
  switch (step) {
    case "title":
      return `Expense: <b>${escapeHtml(state.title ?? "")}</b>`;
    case "amount":
      return `Amount: <b>${total}</b>`;
    case "payers":
      return `Paid by: <b>${namesOf(members, state.payers)}</b>`;
    case "payer_amounts":
      return `Paid: ${breakdown(input, state.payerAmounts, "amount")}`;
    case "sharers":
      return `Shared by: <b>${namesOf(members, state.sharers)}</b>`;
    case "method":
      return `Split: <b>${methodName(state.method)}</b>`;
    case "values":
      return `Split ${methodName(state.method)}: ${breakdown(input, state.values, state.method === "percent" ? "percent" : "amount")}`;
    case "date":
      return `Date: <b>${state.date === null ? "" : formatDay(state.date)}</b>`;
    case "category":
      return `Category: <b>${categoryLabel(state.category)}</b>`;
    case "summary":
    case "menu":
      return null;
  }
}

function breakdown(
  input: SplitScreenInput,
  values: Readonly<Record<string, number>> | null,
  kind: "amount" | "percent",
): string {
  if (values === null) return "";
  return input.members
    .filter((member) => values[member.userId] !== undefined)
    .map((member) => {
      const value = values[member.userId] ?? 0;
      const shown = kind === "percent" ? `${formatBasisPoints(value)}%` : money(input.state, value);
      return `${escapeHtml(member.displayName)} ${shown}`;
    })
    .join(", ");
}

// ---- summary and edit menu ------------------------------------------------------------------

function expenseLines(input: SplitScreenInput, expense: ExpenseInput): string[] {
  const { members } = input;
  const money = (minor: number) => formatMoney(minor, expense.currency);
  const person = (userId: string) => escapeHtml(nameOf(members, userId));
  const shares = expense.shares
    .map((share) => {
      const percent =
        expense.splitMethod === "percent" && share.weight !== null
          ? ` ${formatBasisPoints(share.weight)}%`
          : "";
      return `${person(share.userId)}${percent} ${money(share.amountMinor)}`;
    })
    .join(", ");
  return [
    `<b>${escapeHtml(expense.description)}</b>`,
    `${money(expense.amountMinor)} on ${formatDay(expense.spentOn)}, ${categoryLabel(expense.category)}`,
    expense.payers.length === 1
      ? `Paid by ${person(expense.payers[0]?.userId ?? "")}`
      : `Paid by ${expense.payers.map((p) => `${person(p.userId)} ${money(p.amountMinor)}`).join(", ")}`,
    expense.shares.length === 1
      ? `Shared by ${shares}`
      : `Split ${methodName(expense.splitMethod)}: ${shares}`,
  ];
}

export function renderSummary(input: SplitScreenInput, expense: ExpenseInput): RenderedMessage {
  const lines = ["<b>Check this expense</b>", ...expenseLines(input, expense)];
  if (expense.currency !== "SGD") {
    lines.push("<i>The SGD amount uses that day's exchange rate.</i>");
  }
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        button(input, "Confirm", { kind: "confirm" }),
        button(input, "Edit", { kind: "edit" }),
        button(input, "Cancel", { kind: "cancel" }),
      ],
    ],
  };
}

/** What the summary becomes once the expense is saved. */
export function renderAdded(
  input: SplitScreenInput,
  expense: ExpenseInput,
  link: { readonly appUrl: string; readonly expenseId: string },
): RenderedMessage {
  const path = `/expenses/${link.expenseId}`;
  return {
    text: ["<b>Added</b>", ...expenseLines(input, expense)].join("\n"),
    keyboard: [
      [
        {
          text: "Open in app",
          web_app: { url: `${link.appUrl}/signin?next=${encodeURIComponent(path)}` },
        },
      ],
    ],
  };
}

/** Shown instead of the summary when the answers do not pass the expense checks. */
export function renderProblem(input: SplitScreenInput, message: string): RenderedMessage {
  return {
    text: `<b>Something needs fixing</b>\n${escapeHtml(message)}`,
    keyboard: [
      [button(input, "Edit", { kind: "edit" }), button(input, "Cancel", { kind: "cancel" })],
    ],
  };
}

const EDIT_LABELS: Record<EditField, string> = {
  title: "Title",
  amount: "Amount",
  payers: "Paid by",
  sharers: "Shared by",
  method: "Split",
  date: "Date",
  category: "Category",
};

export function renderEditMenu(input: SplitScreenInput): RenderedMessage {
  const fields = (Object.keys(EDIT_LABELS) as EditField[]).filter(
    (field) => field !== "method" || applies(input.state, "method"),
  );
  return {
    text: "What do you want to change?",
    keyboard: [
      ...rows(
        fields.map((field) => button(input, EDIT_LABELS[field], { kind: "edit_field", field })),
        2,
      ),
      [button(input, "Back", { kind: "back" })],
    ],
  };
}

/** The question that belongs to an edit-menu field. */
export const EDIT_STEP: Readonly<Record<EditField, SplitStep>> = {
  title: "title",
  amount: "amount",
  payers: "payers",
  sharers: "sharers",
  method: "method",
  date: "date",
  category: "category",
};
