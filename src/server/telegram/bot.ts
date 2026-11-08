import type { Update } from "grammy/types";
import type { Database } from "@/db/client";
import { findMemberByTelegramId, type Member } from "@/lib/auth/db/members";
import { mintLoginLink } from "@/lib/auth/db/login-links";
import type { AuthDeps } from "@/lib/auth/deps";
import type { FxRateClient } from "@/lib/fx";
import { cleanBatch, rowToEdit, type DraftEdit, type DraftRow, type DraftView } from "@/lib/import";
import { toggleBatchPayer, toggleRowMember, setRowMode } from "@/lib/import/edit-split";
import { MAX_UPLOAD_BYTES } from "@/lib/import/policy";
import { resolveSplit, type RowSplitOverride } from "@/lib/import/split";
import { CATEGORY_IDS } from "@/lib/ledger/categories";
import { todayIn } from "@/lib/ledger/days";
import { isCurrencyCode, formatRate, parseRate } from "@/lib/money";
import { buildAliasTable, isEmptyPlan, normalizeAlias, parseCaption } from "@/lib/telegram/caption";
import { decodeCallback, type CallbackAction } from "@/lib/telegram/callbacks";
import { isSplitCallback } from "@/lib/telegram/split/callbacks";
import { escapeHtml, clip, MESSAGE_LIMIT } from "@/lib/telegram/html";
import { nudgeRowPercent, parseTypedPercents } from "@/lib/telegram/percent";
import { applyCaptionPlan } from "@/lib/telegram/plan";
import {
  chatConfirmBlocker,
  renderDraft,
  type RenderInput,
  type RenderedMessage,
  type Screen,
} from "@/lib/telegram/render";
import {
  classifyUpdate,
  type Intent,
  type IgnoreReason,
  type Origin,
} from "@/lib/telegram/routing";
import { LedgerError } from "@/server/ledger";
import {
  cancelImport,
  confirmImport,
  uploadScreenshot,
  type ImportDeps,
} from "@/server/import/service";
import { DraftExpiredError, DuplicateImageError, ImportError } from "@/server/import/errors";
import type { ImageExtractor } from "@/server/import/extract/types";
import { createImportStore, type ImportStore } from "@/server/import/store";
import type { ImageStorage } from "@/server/import/storage/types";
import { describeFailure, FileTooLargeError, isUnreachable, type BotApi } from "./api";
import type { BotConfig } from "./config";
import {
  addAlias,
  allowedTelegramIds,
  claimUpdate,
  customAliases,
  dayRates,
  findTrackedDraft,
  parseRowView,
  people,
  setDayRate,
  trackDraftMessage,
  type DraftScreen,
} from "./directory";
import type { Notifier } from "./notify";
import { cancelSplit, handleSplitCallback, handleSplitText, startSplit } from "./split";

export interface BotDeps {
  readonly config: BotConfig;
  readonly api: BotApi;
  readonly db: Database;
  readonly fx: FxRateClient;
  readonly storage: ImageStorage;
  readonly extractor: ImageExtractor;
  readonly dailyLimit: number;
  readonly notifier: Notifier;
  readonly now: () => Date;
  /** Overrides the session secret used to mint login links (tests). */
  readonly sessionSecret?: string;
}

export type UpdateOutcome =
  | { readonly handled: false; readonly reason: IgnoreReason | "duplicate" | "unknown_member" }
  | { readonly handled: true; readonly kind: Intent["kind"] };

const HELP = [
  "<b>lullet</b>",
  "Send me a screenshot of a payment and I will read it. You then check who shares each row and confirm.",
  "",
  "In the group chat, start the photo's caption with <code>/import</code>, because Telegram shows me nothing else there. I will send the draft to you privately.",
  "After it the caption can say who shares: <code>/import split between mei and dad</code>, <i>paid by mum</i>, <i>except dad</i>.",
  "",
  "/import - caption a screenshot with it in the group (in a private chat just send the screenshot)",
  "/split - add an expense by hand: I ask for the title, amount, who paid, who shares and how it is split (private chat only)",
  "/cancel - stop a /split in progress",
  "/rate EUR 1.51 - today's default rate for the group (SGD per 1 EUR)",
  "/login - a one-time link to the web dashboard, sent to you privately",
  "/alias mum mom - another name a caption can use for a member",
  "/help - this message",
].join("\n");

const SCREENSHOT_USAGE =
  "Send /import as the caption of a screenshot, for example <code>/import split between mei and dad</code>. On its own it has nothing to read.";

function importDepsFor(deps: BotDeps, member: Member): ImportDeps {
  return {
    store: storeFor(deps, member),
    storage: deps.storage,
    extractor: deps.extractor,
    dailyLimit: deps.dailyLimit,
    groupId: member.groupId,
    now: deps.now,
  };
}

function storeFor(deps: BotDeps, member: Member): ImportStore {
  return createImportStore({
    db: deps.db,
    session: { userId: member.userId, groupId: member.groupId },
    fx: deps.fx,
    now: deps.now,
  });
}

function authDeps(deps: BotDeps): AuthDeps {
  return {
    db: deps.db,
    now: deps.now(),
    ...(deps.sessionSecret === undefined ? {} : { secret: deps.sessionSecret }),
  };
}

async function safely(label: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`Telegram ${label} failed`, describeFailure(error));
  }
}

/** What the log says about an update: its shape only, never who sent it or what it said. */
function describeUpdate(update: Update): string {
  const message = update.message;
  if (message) {
    const content = message.photo ? "photo" : message.document ? "document" : "text";
    return `message in ${message.chat.type} chat (${content})`;
  }
  if (update.callback_query) return "callback query";
  return "unsupported update";
}

/**
 * Strangers get no reply, but a dropped update is never silent in the logs: without the reason a
 * bot that "does not answer" cannot be told apart from one that was never reached.
 */
function logDropped(update: Update, reason: string): void {
  console.info(`Telegram update dropped: ${reason} - ${describeUpdate(update)}`);
}

/** Entry point: one Telegram update. Never throws; strangers get no reply at all. */
export async function processUpdate(deps: BotDeps, update: Update): Promise<UpdateOutcome> {
  const botUsername = await deps.api.botUsername().catch((error: unknown) => {
    console.warn(
      "Telegram getMe failed, so /command@bot and mentions go unrecognised",
      describeFailure(error),
    );
    return null;
  });
  const intent = classifyUpdate(update, {
    groupChatId: deps.config.groupChatId,
    allowedUserIds: await allowedTelegramIds(deps.db),
    botUsername,
  });
  if (intent.kind === "ignore") {
    logDropped(update, intent.reason);
    return { handled: false, reason: intent.reason };
  }
  if (!(await claimUpdate(deps.db, update.update_id, deps.now()))) {
    logDropped(update, "duplicate");
    return { handled: false, reason: "duplicate" };
  }
  const member = await findMemberByTelegramId(intent.origin.userId, { db: deps.db });
  if (!member) {
    logDropped(update, "unknown_member");
    return { handled: false, reason: "unknown_member" };
  }

  try {
    switch (intent.kind) {
      case "command":
        await handleCommand(deps, member, intent, botUsername);
        break;
      case "image":
        await handleImage(deps, member, intent, botUsername);
        break;
      case "callback":
        await handleCallback(deps, member, intent);
        break;
      case "reply":
        await handleReply(deps, member, intent);
        break;
      case "text":
        await handleSplitText(deps, member, intent.origin, intent.messageId, intent.text);
        break;
    }
  } catch (error) {
    console.error("Telegram update failed", describeFailure(error));
    if (intent.kind === "callback") {
      await safely("answer", () =>
        deps.api.answerCallback(intent.callbackQueryId, "Something went wrong. Try again."),
      );
    }
  }
  return { handled: true, kind: intent.kind };
}

// ---- commands --------------------------------------------------------------------------

type CommandIntent = Extract<Intent, { kind: "command" }>;

async function handleCommand(
  deps: BotDeps,
  member: Member,
  intent: CommandIntent,
  botUsername: string | null,
): Promise<void> {
  const { origin } = intent;
  const reply = (html: string) =>
    deps.api.sendMessage(origin.chatId, html, {
      replyToMessageId: intent.messageId,
      noLinkPreview: true,
    });
  switch (intent.name) {
    case "login":
      return loginCommand(deps, origin, intent.messageId);
    case "rate":
      return rateCommand(deps, member, intent, reply);
    case "alias":
      return aliasCommand(deps, member, intent, reply);
    case "import":
      await reply(SCREENSHOT_USAGE);
      return;
    case "split":
      return startSplit(deps, member, origin, intent.messageId, botUsername);
    case "cancel":
      return cancelSplit(deps, member, origin, intent.messageId);
    case "start":
    case "help":
    case null:
      await reply(HELP);
  }
}

async function loginCommand(deps: BotDeps, origin: Origin, messageId: number): Promise<void> {
  const link = await mintLoginLink(origin.userId, { baseUrl: deps.config.appUrl }, authDeps(deps));
  if (!link) {
    console.info("Telegram login link not minted: the sender has no membership");
    return;
  }
  const html = [
    "Here is your one-time link to the lullet dashboard.",
    "It works once and expires in 10 minutes. Do not forward it.",
  ].join("\n");
  try {
    // A link is private: it always goes to the person's own chat, even when asked for in the group.
    await deps.api.sendMessage(origin.userId, html, {
      noLinkPreview: true,
      keyboard: [[{ text: "Open lullet", url: link.url }]],
    });
    if (origin.chatKind === "group") {
      await deps.api.sendMessage(
        origin.chatId,
        "I sent you a private message with your login link.",
        {
          replyToMessageId: messageId,
        },
      );
    }
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    await deps.api.sendMessage(
      origin.chatId,
      "I cannot message you privately yet. Open a chat with me, press Start, then send /login again.",
      { replyToMessageId: messageId },
    );
  }
}

async function rateCommand(
  deps: BotDeps,
  member: Member,
  intent: CommandIntent,
  reply: (html: string) => Promise<unknown>,
): Promise<void> {
  const day = todayIn(deps.now());
  const match = /^([A-Za-z]{3})\s+(\d+(?:[.,]\d+)?)$/.exec(intent.args.trim());
  if (!match) {
    const current = await dayRates(deps.db, member.groupId, day);
    const lines = current.map((r) => `${r.currency} ${formatRate(parseRate(r.rate))}`);
    await reply(
      [
        "Set today's default rate: <code>/rate EUR 1.51</code> (SGD per 1 EUR).",
        lines.length > 0
          ? `Today's rates: ${lines.join(", ")}.`
          : "No default rates are set for today.",
      ].join("\n"),
    );
    return;
  }
  const currency = (match[1] ?? "").toUpperCase();
  if (!isCurrencyCode(currency) || currency === "SGD") {
    await reply(
      currency === "SGD"
        ? "SGD is the reporting currency, so it needs no rate."
        : `I do not know the currency ${escapeHtml(currency)}.`,
    );
    return;
  }
  let rate: string;
  try {
    rate = formatRate(parseRate((match[2] ?? "").replace(",", ".")));
  } catch {
    await reply("That rate is not valid. Use a plain number like 1.51.");
    return;
  }
  await setDayRate(deps.db, {
    groupId: member.groupId,
    userId: member.userId,
    currency,
    rate,
    day,
    now: deps.now(),
  });
  await reply(`Default rate for ${day} set: 1 ${currency} = ${rate} SGD.`);
}

function usernamesOf(
  group: readonly { userId: string; telegramUsername: string | null }[],
): Map<string, string> {
  return new Map(
    group.flatMap((p) => (p.telegramUsername ? [[p.userId, p.telegramUsername] as const] : [])),
  );
}

async function aliasCommand(
  deps: BotDeps,
  member: Member,
  intent: CommandIntent,
  reply: (html: string) => Promise<unknown>,
): Promise<void> {
  const group = await people(deps.db, member.groupId);
  const extra = await customAliases(deps.db, member.groupId);
  const table = buildAliasTable(group, extra, member.userId, usernamesOf(group));
  const [who = "", ...rest] = intent.args.trim().split(/\s+/);
  const alias = rest.join(" ");
  const target = table.get(who.toLowerCase());
  if (!who || !alias || target === undefined) {
    const list = extra.map(
      (e) =>
        `${escapeHtml(e.alias)} = ${escapeHtml(group.find((p) => p.userId === e.userId)?.displayName ?? "?")}`,
    );
    await reply(
      [
        "Give a member another name: <code>/alias mum mom</code>.",
        list.length > 0 ? `Names so far: ${list.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }
  const result = table.has(normalizeAlias(alias))
    ? "taken"
    : await addAlias(deps.db, member.groupId, target, alias);
  const name = escapeHtml(group.find((p) => p.userId === target)?.displayName ?? "them");
  await reply(
    result === "added"
      ? `OK, captions can now call ${name} "${escapeHtml(clip(alias, 30))}".`
      : result === "taken"
        ? "That name is already in use."
        : "A name needs 2 to 30 characters.",
  );
}

// ---- screenshots -----------------------------------------------------------------------

type ImageIntent = Extract<Intent, { kind: "image" }>;

const READING = "Reading your screenshot...";

function renderInput(
  deps: BotDeps,
  view: DraftView,
  members: readonly { userId: string; displayName: string }[],
): RenderInput {
  return { view, members, secret: deps.config.webhookSecret, appUrl: deps.config.appUrl };
}

function failureText(error: unknown): string {
  if (error instanceof FileTooLargeError) return "That file is too large. The limit is 4 MB.";
  if (error instanceof DuplicateImageError) return "This screenshot was already imported.";
  if (error instanceof ImportError) return escapeHtml(error.message);
  return "Something went wrong reading that screenshot. Please try again.";
}

async function handleImage(
  deps: BotDeps,
  member: Member,
  intent: ImageIntent,
  botUsername: string | null,
): Promise<void> {
  const { api } = deps;
  const { origin } = intent;
  const group = await people(deps.db, member.groupId);
  const me = group.find((p) => p.userId === member.userId)?.displayName ?? origin.firstName;

  // Drafts live in the sender's private chat. A photo in the group gets a short note there.
  let groupNote: number | null = null;
  if (origin.chatKind === "group") {
    const note = await api.sendMessage(
      origin.chatId,
      `Reading ${escapeHtml(me)}'s screenshot. The draft goes to them privately; only the confirmed result is shown here.`,
      { replyToMessageId: intent.messageId },
    );
    groupNote = note.messageId;
  }
  let ackId: number;
  try {
    ackId = (await api.sendMessage(origin.userId, READING)).messageId;
  } catch (error) {
    if (!isUnreachable(error) || groupNote === null) throw error;
    await api.editMessage(
      origin.chatId,
      groupNote,
      "I cannot message you privately yet. Open a chat with me, press Start, then send the screenshot again.",
    );
    return;
  }
  const edit = (html: string, keyboard?: RenderedMessage["keyboard"]) =>
    api.editMessage(origin.userId, ackId, html, keyboard);

  let importId: string;
  try {
    if (intent.fileSize !== null && intent.fileSize > MAX_UPLOAD_BYTES)
      throw new FileTooLargeError();
    const bytes = await api.downloadFile(intent.fileId, MAX_UPLOAD_BYTES);
    const result = await uploadScreenshot(importDepsFor(deps, member), {
      bytes,
      source: "telegram",
      caption: intent.caption,
    });
    importId = result.importId;
  } catch (error) {
    if (!(error instanceof ImportError) && !(error instanceof FileTooLargeError)) {
      console.error("Telegram screenshot failed", describeFailure(error));
    }
    await edit(failureText(error));
    return;
  }

  try {
    await presentDraft();
  } catch (error) {
    console.error("Telegram draft failed", describeFailure(error));
    await safely("edit", () =>
      edit("Your screenshot was read, but I could not show the draft. Open it in the app."),
    );
  }

  async function presentDraft(): Promise<void> {
    const store = storeFor(deps, member);
    let view = await store.getDraft(importId);
    if (!view) return;

    // The caption can say who paid and who shares; it is read by plain code, never sent to the model.
    let note = "";
    const table = buildAliasTable(
      group,
      await customAliases(deps.db, member.groupId),
      member.userId,
      usernamesOf(group),
    );
    const plan = parseCaption(intent.caption, botUsername, table);
    if (!isEmptyPlan(plan) && view.rows.length > 0) {
      const order = group.map((p) => p.userId);
      const applied = applyCaptionPlan(plan, view.batch, order);
      view = await store.saveDraft(importId, {
        batch: applied.batch,
        rows: view.rows.map((row) => ({
          ...rowToEdit(row),
          split: applied.rowSplit ?? row.split,
        })),
      });
    }
    if (plan.unknown.length > 0) {
      note = `\n<i>I did not recognise: ${escapeHtml(clip(plan.unknown.join(", "), 60))}.</i>`;
    }

    const message = renderDraft(renderInput(deps, view, group), { kind: "summary" });
    await trackDraftMessage(deps.db, importId, origin.userId, ackId, "summary", deps.now());
    await edit((message.text + note).slice(0, MESSAGE_LIMIT), message.keyboard);
    if (groupNote !== null) {
      await safely("group note", () =>
        api.editMessage(
          origin.chatId,
          groupNote,
          `${escapeHtml(me)}'s draft is ready in their private chat.`,
        ),
      );
    }
  }
}

// ---- inline buttons --------------------------------------------------------------------

type CallbackIntent = Extract<Intent, { kind: "callback" }>;

function unchanged(view: DraftView): DraftEdit {
  return { batch: view.batch, rows: view.rows.map(rowToEdit) };
}

function withRow(
  view: DraftView,
  index: number,
  change: (row: DraftRow) => Partial<ReturnType<typeof rowToEdit>>,
): DraftEdit {
  const edit = unchanged(view);
  return {
    ...edit,
    rows: edit.rows.map((row, i) => {
      const source = view.rows[i];
      return i === index && source ? { ...row, ...change(source) } : row;
    }),
  };
}

async function handleCallback(
  deps: BotDeps,
  member: Member,
  intent: CallbackIntent,
): Promise<void> {
  const { api } = deps;
  const answered = { done: false };
  const answer = async (text?: string, alert = false) => {
    if (answered.done) return;
    answered.done = true;
    await safely("answer", () => api.answerCallback(intent.callbackQueryId, text, alert));
  };

  if (isSplitCallback(intent.data)) {
    await handleSplitCallback(deps, member, intent);
    return;
  }
  const decoded = decodeCallback(deps.config.webhookSecret, intent.data);
  if (!decoded.ok) {
    await answer("This button is no longer valid.", true);
    return;
  }

  const store = storeFor(deps, member);
  const group = await people(deps.db, member.groupId);
  const order = group.map((p) => p.userId);
  const { importId, action } = decoded;
  const screenOf = (index: number): DraftScreen => `row:${index}`;

  const show = async (view: DraftView, screen: Screen) => {
    const message = renderDraft(renderInput(deps, view, group), screen);
    await trackDraftMessage(
      deps.db,
      importId,
      intent.origin.chatId,
      intent.messageId,
      view.status === "draft"
        ? screen.kind === "row"
          ? screenOf(screen.index)
          : "summary"
        : "result",
      deps.now(),
    );
    await api.editMessage(intent.origin.chatId, intent.messageId, message.text, message.keyboard);
  };

  try {
    const view = await store.getDraft(importId);
    if (!view) {
      await answer("I cannot find that draft any more.", true);
      return;
    }
    // Only the uploader acts on their import; anyone else is told so and nothing changes.
    if (view.uploaderId !== member.userId) {
      const owner = group.find((p) => p.userId === view.uploaderId)?.displayName ?? "the uploader";
      {
        await answer(`Only ${owner} can do that with this import.`, true);
        return;
      }
    }

    if (action.kind === "undo") {
      const { expenseIds } = await store.undo(importId);
      const after = await store.getDraft(importId);
      if (after) await show(after, { kind: "summary" });
      if (expenseIds.length > 0 && after) {
        await deps.notifier.importUndone(
          member.groupId,
          member.userId,
          after.expenses.filter((e) => expenseIds.includes(e.id)),
        );
      }
      {
        await answer("Undone");
        return;
      }
    }
    if (view.status !== "draft") {
      // A stale button on a draft that is already closed: show where it ended up.
      await show(view, { kind: "summary" });
      {
        await answer(view.status === "confirmed" ? "Already added" : "This draft is closed.");
        return;
      }
    }

    switch (action.kind) {
      case "confirm": {
        const blocker = chatConfirmBlocker(view, order);
        if (blocker !== null) {
          await answer(`${blocker} Open it in the app to review.`, true);
          return;
        }
        const result = await confirmImport(importDepsFor(deps, member), importId, unchanged(view));
        const after = await store.getDraft(importId);
        if (after) await show(after, { kind: "summary" });
        if (result.added && after) {
          await deps.notifier.importConfirmed(member.groupId, member.userId, after.expenses);
        }
        {
          await answer(
            result.added ? `Added ${String(result.expenseIds.length)}` : "Already added",
          );
          return;
        }
      }
      case "cancel": {
        await cancelImport(importDepsFor(deps, member), importId);
        const after = await store.getDraft(importId);
        if (after) await show(after, { kind: "summary" });
        {
          await answer("Discarded");
          return;
        }
      }
      case "summary":
        await show(view, { kind: "summary" });
        {
          await answer();
          return;
        }
      case "edit": {
        const index = Math.min(action.row, view.rows.length - 1);
        await show(view, index < 0 ? { kind: "summary" } : { kind: "row", index });
        {
          await answer();
          return;
        }
      }
      default: {
        const next = applyEditAction(view, action, order);
        if (next === null) {
          await answer("That row or person is not available any more.", true);
          return;
        }
        const saved = await store.saveDraft(importId, next.edit);
        await show(saved, { kind: "row", index: next.row });
        {
          await answer();
          return;
        }
      }
    }
  } catch (error) {
    if (error instanceof DraftExpiredError) {
      const view = await store.getDraft(importId).catch(() => null);
      if (view) await safely("edit", () => show(view, { kind: "summary" }));
    }
    if (error instanceof ImportError || error instanceof LedgerError) {
      {
        await answer(clip(error.message, 190), true);
        return;
      }
    }
    throw error;
  }
}

/** One tap in the row editor, as the edit to save and the row to show afterwards. */
function applyEditAction(
  view: DraftView,
  action: Exclude<CallbackAction, { kind: "confirm" | "cancel" | "undo" | "summary" | "edit" }>,
  order: readonly string[],
): { edit: DraftEdit; row: number } | null {
  const row = view.rows[action.row];
  if (!row) return null;
  const memberId = "member" in action ? order[action.member] : undefined;
  if ("member" in action && memberId === undefined) return null;

  const split = (override: RowSplitOverride | null) =>
    withRow(view, action.row, () => ({ split: override }));
  switch (action.kind) {
    case "include":
      return {
        edit: withRow(view, action.row, (r) => ({ included: !r.included })),
        row: action.row,
      };
    case "category": {
      const category = CATEGORY_IDS[action.category];
      return category
        ? { edit: withRow(view, action.row, () => ({ category })), row: action.row }
        : null;
    }
    case "member":
      return memberId
        ? { edit: split(toggleRowMember(view.batch, row.split, memberId, order)), row: action.row }
        : null;
    case "mode":
      return {
        edit: split(setRowMode(view.batch, row.split, action.mode, order)),
        row: action.row,
      };
    case "nudge":
      return memberId
        ? {
            edit: split(nudgeRowPercent(view.batch, row.split, memberId, action.delta, order)),
            row: action.row,
          }
        : null;
    case "payer": {
      if (!memberId) return null;
      const batch = cleanBatch(
        toggleBatchPayer(view.batch, memberId, order),
        order,
        view.uploaderId,
      );
      return { edit: { ...unchanged(view), batch }, row: action.row };
    }
  }
}

// ---- typed replies ---------------------------------------------------------------------

type ReplyIntent = Extract<Intent, { kind: "reply" }>;

/** A reply to the row editor with percentages ("60 40") sets the split of the row being shown. */
async function handleReply(deps: BotDeps, member: Member, intent: ReplyIntent): Promise<void> {
  const tracked = await findTrackedDraft(deps.db, intent.origin.chatId, intent.replyToMessageId);
  const rowIndex = tracked ? parseRowView(tracked.view) : null;
  if (!tracked || rowIndex === null) {
    // Not an answer for a draft; it may answer a /split question.
    await handleSplitText(deps, member, intent.origin, intent.messageId, intent.text);
    return;
  }

  const store = storeFor(deps, member);
  const view = await store.getDraft(tracked.importId);
  const row = view?.rows[rowIndex];
  if (!view || !row || view.status !== "draft" || view.uploaderId !== member.userId) return;

  const group = await people(deps.db, member.groupId);
  const order = group.map((p) => p.userId);
  const resolved = resolveSplit(view.batch, row.split, order);
  const say = (html: string) =>
    deps.api.sendMessage(intent.origin.chatId, html, { replyToMessageId: intent.messageId });
  if (!resolved.ok || resolved.split.mode !== "percent") {
    await say("Switch this row to Percent first, then reply with the percentages.");
    return;
  }
  const typed = parseTypedPercents(intent.text, resolved.split.members);
  if (!typed.ok) {
    await say(escapeHtml(typed.message));
    return;
  }
  const edit = withRow(view, rowIndex, () => ({
    split: {
      mode: "percent",
      members: [...resolved.split.members],
      percents: { ...typed.percents },
    },
  }));
  const saved = await store.saveDraft(tracked.importId, edit);
  const message = renderDraft(renderInput(deps, saved, group), { kind: "row", index: rowIndex });
  await deps.api.editMessage(
    intent.origin.chatId,
    intent.replyToMessageId,
    message.text,
    message.keyboard,
  );
  const echoed = resolved.split.members.map((id) => {
    const name = group.find((p) => p.userId === id)?.displayName ?? "?";
    return `${escapeHtml(name)} ${formatPercent(typed.percents[id] ?? 0)}`;
  });
  await say(`Set to ${echoed.join(", ")}.`);
}

function formatPercent(basisPoints: number): string {
  return `${String(basisPoints / 100)}%`;
}
