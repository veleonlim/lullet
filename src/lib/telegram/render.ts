import type { InlineKeyboardButton } from "grammy/types";
import {
  computeTotals,
  isBlocking,
  rowState,
  resolveSplit,
  validateForConfirm,
  FAILURE_TEXT,
  type DraftRow,
  type DraftView,
} from "@/lib/import";
import { categoryLabel, CATEGORIES } from "@/lib/ledger/categories";
import { formatDate } from "@/lib/ledger/days";
import { formatMoney } from "@/lib/ledger/format";
import { formatBasisPoints } from "@/lib/ledger/format";
import { isCurrencyCode, isIsoDate } from "@/lib/money";
import { encodeCallback, type CallbackAction } from "./callbacks";
import { clip, escapeHtml, MESSAGE_LIMIT } from "./html";

/**
 * The draft as a Telegram message: text (HTML) plus inline buttons. Pure functions of the draft,
 * the members and the app address, so every screen is tested without a bot. A message is capped
 * at 4096 characters, so the row list gives way (with a pointer to the app) before the cap is hit.
 */

export interface Person {
  readonly userId: string;
  readonly displayName: string;
}

export interface RenderInput {
  readonly view: DraftView;
  /** In the group's fixed member order. */
  readonly members: readonly Person[];
  readonly secret: string;
  readonly appUrl: string;
}

export type Screen =
  { readonly kind: "summary" } | { readonly kind: "row"; readonly index: number };

export interface RenderedMessage {
  readonly text: string;
  readonly keyboard: InlineKeyboardButton[][];
}

/** Chat Confirm is offered only for a draft of at most this many rows. */
export const CHAT_CONFIRM_MAX_ROWS = 10;

const MEMBER_BUTTON_NAME = 12;

function name(members: readonly Person[], userId: string): string {
  return members.find((m) => m.userId === userId)?.displayName ?? "Someone";
}

function names(members: readonly Person[], ids: readonly string[]): string {
  return ids.map((id) => escapeHtml(name(members, id))).join(", ");
}

/**
 * Mini App addresses go through the sign-in page, which signs the member in from Telegram's signed
 * launch data and then continues to `path`, so no page depends on a redirect keeping the data.
 */
function appLink(input: RenderInput, path: string): string {
  return `${input.appUrl}/signin?next=${encodeURIComponent(path)}`;
}

function button(input: RenderInput, text: string, action: CallbackAction): InlineKeyboardButton {
  return { text, callback_data: encodeCallback(input.secret, input.view.id, action) };
}

function openInApp(input: RenderInput, path = `/imports/${input.view.id}`): InlineKeyboardButton {
  return { text: "Open in app", web_app: { url: appLink(input, path) } };
}

function hasUnreadable(row: DraftRow): boolean {
  return isBlocking(row.fieldStates) || Object.values(row.fieldStates).includes("unreadable");
}

/** Why a draft cannot be confirmed from chat, or null when it can (the agreed "clean draft"). */
export function chatConfirmBlocker(view: DraftView, order: readonly string[]): string | null {
  if (view.status !== "draft") return "closed";
  if (view.extractionError !== null) return "The screenshot could not be read.";
  if (view.rows.length === 0) return "No payments were found.";
  if (view.rows.length > CHAT_CONFIRM_MAX_ROWS) {
    return `More than ${String(CHAT_CONFIRM_MAX_ROWS)} rows.`;
  }
  if (view.rows.some(hasUnreadable)) return "Some rows need input.";
  if (
    view.rows.some((row) => row.duplicateOf !== null || row.issues.includes("possible_duplicate"))
  ) {
    return "Some rows may already be recorded.";
  }
  try {
    const checked = validateForConfirm(view.rows, view.batch, order);
    return checked.ok ? null : checked.message;
  } catch {
    // A payer who is not in the group cannot be paid back; the app lets the uploader fix it.
    return "Pick who paid.";
  }
}

function money(row: DraftRow): string {
  return row.amountMinor !== null && row.currency !== null
    ? formatMoney(row.amountMinor, row.currency)
    : "amount?";
}

function flags(row: DraftRow): string {
  const out: string[] = [];
  if (row.duplicateOf !== null)
    out.push(`may repeat ${escapeHtml(clip(row.duplicateOf.label, 40))}`);
  const state = rowState(row.fieldStates);
  if (state === "unreadable") out.push("needs input");
  else if (state !== "clear") out.push("check");
  if (!row.included) out.push("not included");
  return out.length > 0 ? ` <i>(${out.join(", ")})</i>` : "";
}

function rowMembers(view: DraftView, row: DraftRow, order: readonly string[]) {
  return resolveSplit(view.batch, row.split, order);
}

function rowLine(input: RenderInput, row: DraftRow, index: number): string {
  const order = input.members.map((m) => m.userId);
  const merchant = escapeHtml(clip(row.merchant ?? "unknown", 40));
  let line = `${String(index + 1)}. ${merchant}, ${money(row)}, ${categoryLabel(row.category)}`;
  if (row.split !== null) {
    const split = rowMembers(input.view, row, order);
    if (split.ok) line += `, ${names(input.members, split.split.members)}`;
  }
  return line + flags(row);
}

function describePayers(input: RenderInput): string {
  const { batch } = input.view;
  const order = input.members.map((m) => m.userId);
  const payers = names(input.members, batch.payerIds);
  const rest = resolveSplit(batch, null, order);
  const sharers = rest.ok ? names(input.members, rest.split.members) : "";
  const how = batch.mode === "percent" ? "by percent" : "equally";
  return `Paid by ${payers}. Shared ${how}${sharers ? ` between ${sharers}` : ""}.`;
}

/** Total and per-person shares of the rows that would be added, per currency. */
function totalsLines(input: RenderInput): { count: number; lines: string[] } {
  const order = input.members.map((m) => m.userId);
  const going = input.view.rows.filter((row) => row.included);
  const usable: {
    amountMinor: number;
    currency: string;
    split: NonNullable<ReturnType<typeof usableSplit>>;
  }[] = [];
  function usableSplit(row: DraftRow) {
    const split = rowMembers(input.view, row, order);
    return split.ok ? split.split : null;
  }
  for (const row of going) {
    const split = usableSplit(row);
    if (row.amountMinor !== null && row.currency !== null && split) {
      usable.push({ amountMinor: row.amountMinor, currency: row.currency, split });
    }
  }
  // Totals need at least one payer who is really in the group; otherwise just count the rows.
  const payers = order.filter((id) => input.view.batch.payerIds.includes(id));
  if (payers.length === 0) return { count: going.length, lines: [] };
  const totals = computeTotals(usable, payers, order);
  const byCurrency = new Map<string, number>();
  for (const row of usable) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amountMinor);
  }
  const lines: string[] = [];
  for (const [currency, total] of byCurrency) {
    if (!isCurrencyCode(currency)) continue;
    const shares = totals
      .map((person) => ({ id: person.userId, owes: person.byCurrency[currency]?.owesMinor ?? 0 }))
      .filter((entry) => entry.owes > 0)
      .map(
        (entry) =>
          `${escapeHtml(name(input.members, entry.id))} ${formatMoney(entry.owes, currency)}`,
      );
    lines.push(
      `<b>${formatMoney(total, currency)}</b>${shares.length > 0 ? ` - shares: ${shares.join(", ")}` : ""}`,
    );
  }
  return { count: going.length, lines };
}

/** Header and footer are kept whole; rows are added while they fit, then summarised. */
function fit(
  head: string[],
  rows: string[],
  foot: string[],
  moreText: (n: number) => string,
): string {
  const joined = (list: string[]) => list.join("\n");
  const base = [...head, "", "__ROWS__", "", ...foot];
  const fixed = joined(base).length - "__ROWS__".length;
  let budget = MESSAGE_LIMIT - fixed - 120;
  const shown: string[] = [];
  for (const row of rows) {
    if (row.length + 1 > budget) break;
    shown.push(row);
    budget -= row.length + 1;
  }
  if (shown.length < rows.length) shown.push(moreText(rows.length - shown.length));
  const text = joined(base).replace("__ROWS__", joined(shown));
  // Last line of defence; the budget above should always make this a no-op.
  return text.length <= MESSAGE_LIMIT ? text : text.slice(0, MESSAGE_LIMIT - 1);
}

function more(n: number): string {
  return `...and ${String(n)} more. Open in app to see them.`;
}

export function renderSummary(input: RenderInput): RenderedMessage {
  const { view } = input;
  const order = input.members.map((m) => m.userId);
  const head = ["<b>Draft from your screenshot</b>"];
  const foot: string[] = [];
  const rows = view.rows.map((row, index) => rowLine(input, row, index));

  if (view.extractionError !== null) {
    head.push(escapeHtml(FAILURE_TEXT[view.extractionError]));
  } else if (view.rows.length === 0) {
    head.push("I could not find any payments in this screenshot. Open in app to add them by hand.");
  } else {
    head.push(describePayers(input));
    const totals = totalsLines(input);
    foot.push(`Adding ${String(totals.count)} of ${String(view.rows.length)} rows:`);
    foot.push(...(totals.lines.length > 0 ? totals.lines : ["nothing yet"]));
  }
  for (const note of view.notes.slice(0, 2)) foot.push(`<i>${escapeHtml(clip(note, 120))}</i>`);

  const blocker = chatConfirmBlocker(view, order);
  if (blocker !== null && blocker !== "closed" && view.rows.length > 0) {
    foot.push(`${escapeHtml(blocker)} Open in app to review before adding.`);
  }

  const keyboard: InlineKeyboardButton[][] = [];
  if (blocker === null) {
    keyboard.push([
      button(input, `Confirm ${String(view.rows.filter((r) => r.included).length)}`, {
        kind: "confirm",
      }),
    ]);
  }
  const second: InlineKeyboardButton[] = [];
  if (view.rows.length > 0) second.push(button(input, "Edit rows", { kind: "edit", row: 0 }));
  second.push(openInApp(input));
  keyboard.push(second, [button(input, "Cancel", { kind: "cancel" })]);
  return { text: fit(head, rows, foot, more), keyboard };
}

function memberTag(input: RenderInput, row: DraftRow, userId: string): boolean {
  const split = rowMembers(
    input.view,
    row,
    input.members.map((m) => m.userId),
  );
  return split.ok && split.split.members.includes(userId);
}

export function renderRowEditor(input: RenderInput, index: number): RenderedMessage {
  const { view } = input;
  const last = view.rows.length - 1;
  const at = Math.min(Math.max(index, 0), last);
  const row = view.rows[at];
  if (!row) return renderSummary(input);
  const order = input.members.map((m) => m.userId);
  const split = rowMembers(view, row, order);

  const day = row.spentOn !== null && isIsoDate(row.spentOn) ? `, ${formatDate(row.spentOn)}` : "";
  const text = [
    `<b>Row ${String(at + 1)} of ${String(view.rows.length)}</b>`,
    `${escapeHtml(clip(row.merchant ?? "unknown", 60))}, ${money(row)}, ${categoryLabel(row.category)}${day}${flags(row)}`,
    `Paid by ${names(input.members, view.batch.payerIds)}.`,
    split.ok
      ? split.split.mode === "percent" && split.split.basisPoints
        ? `Shared by percent: ${split.split.members
            .map(
              (id) =>
                `${escapeHtml(name(input.members, id))} ${formatBasisPoints(split.split.basisPoints?.[id] ?? 0)}%`,
            )
            .join(", ")}.`
        : `Shared equally between ${names(input.members, split.split.members)}.`
      : `<b>${escapeHtml(split.message)}</b>`,
    split.ok && split.split.mode === "percent"
      ? "Tap the +5% and -5% buttons, or reply to this message with percentages like 60 40."
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const at_ = (kind: "member" | "payer", i: number): CallbackAction =>
    kind === "member"
      ? { kind: "member", row: at, member: i }
      : { kind: "payer", row: at, member: i };
  const keyboard: InlineKeyboardButton[][] = [];
  keyboard.push([
    button(input, row.included ? "Included in import" : "Not included - tap to include", {
      kind: "include",
      row: at,
    }),
  ]);
  keyboard.push(
    input.members.map((m, i) =>
      button(
        input,
        `${memberTag(input, row, m.userId) ? "✓" : "✗"} ${clip(m.displayName, MEMBER_BUTTON_NAME)}`,
        at_("member", i),
      ),
    ),
  );
  const percent = split.ok && split.split.mode === "percent";
  keyboard.push([
    button(input, `${percent ? "" : "● "}Equal`, { kind: "mode", row: at, mode: "equal" }),
    button(input, `${percent ? "● " : ""}Percent`, { kind: "mode", row: at, mode: "percent" }),
  ]);
  if (split.ok && percent) {
    for (const id of split.split.members) {
      const i = input.members.findIndex((m) => m.userId === id);
      const label = clip(name(input.members, id), MEMBER_BUTTON_NAME);
      keyboard.push([
        button(input, `${label} -5%`, { kind: "nudge", row: at, member: i, delta: -1 }),
        button(input, `${label} +5%`, { kind: "nudge", row: at, member: i, delta: 1 }),
      ]);
    }
  }
  for (let start = 0; start < CATEGORIES.length; start += 3) {
    keyboard.push(
      CATEGORIES.slice(start, start + 3).map((category, offset) =>
        button(input, `${category.id === row.category ? "● " : ""}${category.label}`, {
          kind: "category",
          row: at,
          category: start + offset,
        }),
      ),
    );
  }
  keyboard.push(
    input.members.map((m, i) =>
      button(
        input,
        `${view.batch.payerIds.includes(m.userId) ? "💳" : "·"} ${clip(m.displayName, MEMBER_BUTTON_NAME)}`,
        at_("payer", i),
      ),
    ),
  );
  const nav: InlineKeyboardButton[] = [];
  if (at > 0) nav.push(button(input, "‹ Prev", { kind: "edit", row: at - 1 }));
  nav.push(button(input, "Summary", { kind: "summary" }));
  if (at < last) nav.push(button(input, "Next ›", { kind: "edit", row: at + 1 }));
  keyboard.push(nav);
  return { text: text.slice(0, MESSAGE_LIMIT), keyboard };
}

export function renderDraft(input: RenderInput, screen: Screen): RenderedMessage {
  const { view } = input;
  if (view.status === "draft") {
    return screen.kind === "row" ? renderRowEditor(input, screen.index) : renderSummary(input);
  }
  if (view.status === "confirmed") return renderConfirmed(input);
  const text =
    view.status === "undone"
      ? "Undone. The expenses from this import were removed from the ledger."
      : view.status === "cancelled"
        ? "Discarded. Nothing was added."
        : "This draft expired after 24 hours. Send the screenshot again.";
  return { text, keyboard: [] };
}

export function renderConfirmed(input: RenderInput): RenderedMessage {
  const { view } = input;
  const live = view.expenses.filter((e) => e.deletedAt === null);
  const lines = live.map((e) => {
    const amount = isCurrencyCode(e.currency)
      ? formatMoney(e.amountMinor, e.currency)
      : `${String(e.amountMinor)} ${e.currency}`;
    return `${escapeHtml(clip(e.description, 40))}, ${amount}`;
  });
  const text = fit(
    [`<b>Added ${String(live.length)} expense${live.length === 1 ? "" : "s"}</b>`],
    lines,
    ["Use Undo to take them out again."],
    more,
  );
  return {
    text,
    keyboard: [
      [
        button(input, "Undo", { kind: "undo" }),
        { text: "Open in app", web_app: { url: appLink(input, "/expenses") } },
      ],
    ],
  };
}
