import type { InlineKeyboardButton } from "grammy/types";
import type { Database } from "@/db/client";
import type { Member } from "@/lib/auth/db/members";
import type { FxRateClient } from "@/lib/fx";
import { CATEGORY_IDS } from "@/lib/ledger/categories";
import { todayIn } from "@/lib/ledger/days";
import { allocateSplit } from "@/lib/money";
import { escapeHtml } from "@/lib/telegram/html";
import type { Origin } from "@/lib/telegram/routing";
import { decodeSplitCallback, type SplitAction } from "@/lib/telegram/split/callbacks";
import {
  readAmount,
  readAmountList,
  readCategory,
  readDay,
  readPercentList,
  readTitle,
  shiftDay,
} from "@/lib/telegram/split/input";
import {
  EDIT_STEP,
  inGroupOrder,
  renderAdded,
  renderEditMenu,
  renderProblem,
  renderQuestion,
  renderRecap,
  renderSummary,
  type SplitScreenInput,
} from "@/lib/telegram/split/render";
import {
  checkSplit,
  CURRENCY_BUTTONS,
  errorFor,
  initialSplitState,
  startEditing,
  stepAfter,
  toggled,
  withAmount,
  withCategory,
  withDate,
  withMethod,
  withPayerAmounts,
  withPayers,
  withSharers,
  withTitle,
  withValues,
  type SplitState,
  type SplitStep,
} from "@/lib/telegram/split/state";
import { LedgerError, RateUnavailableError } from "@/server/ledger";
import { createLedgerStore } from "@/server/ledger/store";
import { describeFailure, type BotApi } from "./api";
import type { BotConfig } from "./config";
import { people } from "./directory";
import type { Notifier } from "./notify";
import {
  CONFIRMING,
  claimConfirm,
  deleteFlow,
  deleteMemberFlow,
  findFlow,
  groupTimeZone,
  releaseConfirm,
  saveFlow,
  startFlow,
  type SplitFlow,
} from "./split-store";

/**
 * /split: add an expense by answering the bot's questions in a private chat. This is the manual
 * counterpart of the screenshot import. The conversation lives in the database (`split-store.ts`),
 * and the finished answers go through the same checks (`validateExpenseForm`) and the same ledger
 * store (`createExpense`, with its rounding, exchange rates and audit log) and the same group
 * announcement as the web form.
 */

export interface SplitDeps {
  readonly config: BotConfig;
  readonly api: BotApi;
  readonly db: Database;
  readonly fx: FxRateClient;
  readonly notifier: Notifier;
  readonly now: () => Date;
}

const BUTTONS_HINT = "Use the buttons above to answer, or /cancel to stop.";
const EXPIRED = "That /split ran out of time. Send /split to start again.";
const FINISHED = "That /split is already finished. Send /split to add another expense.";

async function safely(label: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`Telegram ${label} failed`, describeFailure(error));
  }
}

interface Screen {
  readonly text: string;
  readonly keyboard: InlineKeyboardButton[][];
}

interface Context {
  readonly deps: SplitDeps;
  readonly member: Member;
  readonly chatId: number;
  readonly members: readonly { userId: string; displayName: string }[];
  readonly today: string;
}

async function contextFor(deps: SplitDeps, member: Member, chatId: number): Promise<Context> {
  const members = await people(deps.db, member.groupId);
  const zone = await groupTimeZone(deps.db, member.groupId);
  return { deps, member, chatId, members, today: todayIn(deps.now(), zone) };
}

function memberIds(ctx: Context): string[] {
  return ctx.members.map((m) => m.userId);
}

/** What the expense checks say about the given fields of these answers, or null if all is well. */
function problemWith(ctx: Context, state: SplitState, ...fields: string[]): string | null {
  const checked = checkSplit(state, { memberIds: memberIds(ctx), today: ctx.today });
  return checked.ok ? null : errorFor(checked.errors, ...fields);
}

function screenFor(
  ctx: Context,
  flow: SplitFlow,
  state: SplitState = flow.state,
): SplitScreenInput {
  return { flowId: flow.id, secret: ctx.deps.config.webhookSecret, state, members: ctx.members };
}

/** The message that asks `step`, with the summary's validation folded in. */
function screenOf(ctx: Context, flow: SplitFlow, state: SplitState, step: SplitStep): Screen {
  const input = screenFor(ctx, flow, state);
  if (step === "menu") return renderEditMenu(input);
  if (step !== "summary") return renderQuestion(input, step);
  const checked = checkSplit(state, { memberIds: memberIds(ctx), today: ctx.today });
  return checked.ok
    ? renderSummary(input, checked.expense)
    : renderProblem(input, Object.values(checked.errors)[0] ?? "Check the answers.");
}

// ---- starting and stopping ------------------------------------------------------------------

type CommandOrigin = Origin;

/** /split. In the group it only points to the private chat, where the questions are asked. */
export async function startSplit(
  deps: SplitDeps,
  member: Member,
  origin: CommandOrigin,
  messageId: number,
  botUsername: string | null,
): Promise<void> {
  if (origin.chatKind !== "private") {
    const where = botUsername
      ? `a private chat with @${escapeHtml(botUsername)}`
      : "a private chat with me";
    await deps.api.sendMessage(
      origin.chatId,
      `/split works in ${where}. Open it and send /split there.`,
      {
        replyToMessageId: messageId,
      },
    );
    return;
  }
  const ctx = await contextFor(deps, member, origin.chatId);
  const state = initialSplitState({ userId: member.userId, memberIds: memberIds(ctx) });
  const flow = await startFlow(deps.db, {
    groupId: member.groupId,
    userId: member.userId,
    chatId: origin.chatId,
    state,
    now: deps.now(),
  });
  const question = screenOf(ctx, flow, state, "title");
  const sent = await deps.api.sendMessage(origin.chatId, question.text, {
    keyboard: question.keyboard,
  });
  await saveFlow(deps.db, flow, { messageId: sent.messageId }, deps.now());
}

/** /cancel: drops the open flow, wherever it stands. */
export async function cancelSplit(
  deps: SplitDeps,
  member: Member,
  origin: CommandOrigin,
  messageId: number,
): Promise<void> {
  if (origin.chatKind !== "private") return;
  const found = await findFlow(deps.db, member, deps.now());
  if (found.kind === "open" && found.flow.step === CONFIRMING) {
    await deps.api.sendMessage(origin.chatId, "One moment, I am adding it.", {
      replyToMessageId: messageId,
    });
    return;
  }
  const shown = found.kind === "open" ? found.flow.messageId : null;
  const removed = await deleteMemberFlow(deps.db, member);
  if (shown !== null) {
    await safely("edit", () => deps.api.editMessage(origin.chatId, shown, "Cancelled."));
  }
  await deps.api.sendMessage(
    origin.chatId,
    removed
      ? "Cancelled. Nothing was added."
      : "There is nothing to cancel. Send /split to add an expense.",
    { replyToMessageId: messageId },
  );
}

// ---- typed answers --------------------------------------------------------------------------

/**
 * A plain message in a private chat. It answers the open /split question; with no flow open it is
 * ignored, as any chat with the bot was before /split existed.
 */
export async function handleSplitText(
  deps: SplitDeps,
  member: Member,
  origin: Origin,
  messageId: number,
  text: string,
): Promise<void> {
  if (origin.chatKind !== "private") return;
  const found = await findFlow(deps.db, member, deps.now());
  if (found.kind === "none") return;
  const say = (html: string) =>
    deps.api.sendMessage(origin.chatId, html, { replyToMessageId: messageId });
  if (found.kind === "expired") {
    await deleteMemberFlow(deps.db, member);
    await say(EXPIRED);
    return;
  }
  const { flow } = found;
  if (flow.step === CONFIRMING) {
    await say("One moment, I am adding it.");
    return;
  }
  const step = flow.step;
  const ctx = await contextFor(deps, member, origin.chatId);
  const { state } = flow;
  const complain = (message: string) => say(escapeHtml(message));

  switch (step) {
    case "title": {
      const title = readTitle(text);
      if (!title.ok) await complain(title.message);
      else await moveOn(ctx, flow, step, withTitle(state, title.value));
      return;
    }
    case "amount": {
      const amount = readAmount(text, state.currency);
      if (!amount.ok) await complain(amount.message);
      else {
        const next = withAmount(state, amount.value.minor, amount.value.currency);
        await moveOn(ctx, flow, step, next);
      }
      return;
    }
    case "payer_amounts": {
      const payers = inGroupOrder(ctx.members, state.payers);
      const amounts = readAmountList(text, payers, state.currency, state.amountMinor ?? 0);
      if (!amounts.ok) {
        await complain(amounts.message);
        return;
      }
      const next = withPayerAmounts(state, amounts.value);
      const problem = problemWith(ctx, next, "payers");
      if (problem !== null) await complain(problem);
      else await moveOn(ctx, flow, step, next);
      return;
    }
    case "values": {
      const sharers = inGroupOrder(ctx.members, state.sharers);
      const values =
        state.method === "percent"
          ? readPercentList(text, sharers)
          : readAmountList(text, sharers, state.currency, state.amountMinor ?? 0);
      if (!values.ok) {
        await complain(values.message);
        return;
      }
      const next = withValues(state, values.value);
      const problem = problemWith(ctx, next, "split");
      if (problem !== null) await complain(problem);
      else await moveOn(ctx, flow, step, next);
      return;
    }
    case "date": {
      const day = readDay(text, ctx.today);
      if (!day.ok) await complain(day.message);
      else await moveOn(ctx, flow, step, withDate(state, day.value));
      return;
    }
    case "category": {
      const category = readCategory(text);
      if (!category.ok) await complain(category.message);
      else await moveOn(ctx, flow, step, withCategory(state, category.value));
      return;
    }
    default:
      await say(BUTTONS_HINT);
  }
}

// ---- moving between questions ---------------------------------------------------------------

/**
 * `answered` is done: turn its message into a one line recap, ask what comes next in a new
 * message, and save. The new message goes out before the save, so the saved flow always matches
 * something the person has seen.
 */
async function moveOn(
  ctx: Context,
  flow: SplitFlow,
  answered: SplitStep,
  answers: SplitState,
  tapped?: number,
): Promise<void> {
  const { api } = ctx.deps;
  const next = stepAfter(answers, answered);
  const state = next === "summary" && answers.editing ? { ...answers, editing: false } : answers;
  const question = screenOf(ctx, flow, state, next);
  const sent = await api.sendMessage(ctx.chatId, question.text, { keyboard: question.keyboard });
  const saved = await saveFlow(
    ctx.deps.db,
    flow,
    { step: next, state, messageId: sent.messageId },
    ctx.deps.now(),
  );
  if (saved === null) return;
  await recap(ctx, flow, answered, state, tapped ?? flow.messageId);
}

/** Rewrites the answered question's message to a line without buttons (best effort). */
async function recap(
  ctx: Context,
  flow: SplitFlow,
  answered: SplitStep,
  state: SplitState,
  messageId: number | null,
): Promise<void> {
  const line = renderRecap(screenFor(ctx, flow, state), answered);
  if (line === null || messageId === null) return;
  await safely("edit", () => ctx.deps.api.editMessage(ctx.chatId, messageId, line));
}

/** Redraws the current screen in place (toggles, currency, menu) and saves. */
async function redraw(
  ctx: Context,
  flow: SplitFlow,
  step: SplitStep,
  state: SplitState,
  messageId: number,
): Promise<boolean> {
  const screen = screenOf(ctx, flow, state, step);
  const saved = await saveFlow(ctx.deps.db, flow, { step, state, messageId }, ctx.deps.now());
  if (saved === null) return false;
  await ctx.deps.api.editMessage(ctx.chatId, messageId, screen.text, screen.keyboard);
  return true;
}

// ---- buttons --------------------------------------------------------------------------------

export interface SplitTap {
  readonly origin: Origin;
  readonly callbackQueryId: string;
  readonly messageId: number;
  readonly data: string;
}

export async function handleSplitCallback(
  deps: SplitDeps,
  member: Member,
  tap: SplitTap,
): Promise<void> {
  const answered = { done: false };
  const answer = async (text?: string, alert = false) => {
    if (answered.done) return;
    answered.done = true;
    await safely("answer", () => deps.api.answerCallback(tap.callbackQueryId, text, alert));
  };

  const decoded = decodeSplitCallback(deps.config.webhookSecret, tap.data);
  if (!decoded.ok || tap.origin.chatKind !== "private") {
    await answer("This button is no longer valid.", true);
    return;
  }
  const found = await findFlow(deps.db, member, deps.now());
  if (found.kind === "expired") {
    await deleteMemberFlow(deps.db, member);
    await safely("edit", () => deps.api.editMessage(tap.origin.chatId, tap.messageId, EXPIRED));
    await answer("This /split ran out of time.", true);
    return;
  }
  if (found.kind === "none") {
    await answer(FINISHED, true);
    return;
  }
  const { flow } = found;
  if (flow.id !== decoded.flowId) {
    await answer("That is from an earlier /split.", true);
    return;
  }
  if (flow.step === CONFIRMING) {
    await answer("Adding it now...");
    return;
  }

  const ctx = await contextFor(deps, member, tap.origin.chatId);
  const note = await applyAction(ctx, flow, flow.step, decoded.action, tap.messageId);
  await answer(note?.text, note?.alert ?? false);
}

interface Note {
  readonly text: string;
  readonly alert: boolean;
}

const stale = (): Note => ({ text: "That question was already answered.", alert: false });
const alert = (text: string): Note => ({ text, alert: true });

/** One tap. Returns what to say back in the little toast Telegram shows, if anything. */
async function applyAction(
  ctx: Context,
  flow: SplitFlow,
  step: SplitStep,
  action: SplitAction,
  tapped: number,
): Promise<Note | undefined> {
  const { state } = flow;
  const order = memberIds(ctx);
  const personAt = (index: number) => ctx.members[index]?.userId;

  switch (action.kind) {
    case "cancel": {
      await deleteFlow(ctx.deps.db, flow.id);
      await safely("edit", () =>
        ctx.deps.api.editMessage(ctx.chatId, tapped, "Cancelled. Nothing was added."),
      );
      return { text: "Cancelled", alert: false };
    }
    case "currency": {
      const currency = CURRENCY_BUTTONS[action.index];
      if (step !== "amount" || currency === undefined) return stale();
      if (!(await redraw(ctx, flow, "amount", { ...state, currency }, tapped))) return stale();
      return undefined;
    }
    case "payer":
    case "sharer": {
      const wanted = action.kind === "payer" ? "payers" : "sharers";
      const userId = personAt(action.member);
      if (step !== wanted || userId === undefined) return stale();
      const next =
        action.kind === "payer"
          ? withPayers(state, toggled(state.payers, userId))
          : withSharers(state, toggled(state.sharers, userId));
      if (!(await redraw(ctx, flow, wanted, next, tapped))) return stale();
      return undefined;
    }
    case "payers_done": {
      if (step !== "payers") return stale();
      if (state.payers.length === 0) return alert("Pick at least one person who paid.");
      await moveOn(ctx, flow, "payers", state, tapped);
      return undefined;
    }
    case "payers_equal": {
      if (step !== "payer_amounts" || state.amountMinor === null) return stale();
      const payers = inGroupOrder(ctx.members, state.payers);
      const split = allocateSplit(state.amountMinor, { kind: "equal", members: payers }, order);
      const amounts = Object.fromEntries(split.map((part) => [part.memberId, part.minor]));
      await moveOn(ctx, flow, "payer_amounts", withPayerAmounts(state, amounts), tapped);
      return undefined;
    }
    case "sharers_done": {
      if (step !== "sharers") return stale();
      if (state.sharers.length === 0) return alert("Pick at least one person who shared it.");
      await moveOn(ctx, flow, "sharers", state, tapped);
      return undefined;
    }
    case "method": {
      if (step !== "method") return stale();
      await moveOn(ctx, flow, "method", withMethod(state, action.method), tapped);
      return undefined;
    }
    case "day": {
      if (step !== "date") return stale();
      const day = action.day === "today" ? ctx.today : shiftDay(ctx.today, -1);
      await moveOn(ctx, flow, "date", withDate(state, day), tapped);
      return undefined;
    }
    case "category":
    case "category_skip": {
      if (step !== "category") return stale();
      const category = action.kind === "category" ? CATEGORY_IDS[action.index] : state.category;
      if (category === undefined) return stale();
      await moveOn(ctx, flow, "category", withCategory(state, category), tapped);
      return undefined;
    }
    case "edit": {
      if (step !== "summary") return stale();
      if (!(await redraw(ctx, flow, "menu", state, tapped))) return stale();
      return undefined;
    }
    case "back": {
      if (step !== "menu") return stale();
      if (!(await redraw(ctx, flow, "summary", { ...state, editing: false }, tapped)))
        return stale();
      return undefined;
    }
    case "edit_field": {
      if (step !== "menu") return stale();
      const target = EDIT_STEP[action.field];
      if (!(await redraw(ctx, flow, target, startEditing(state), tapped))) return stale();
      return undefined;
    }
    case "confirm": {
      if (step !== "summary") return stale();
      return confirm(ctx, flow, tapped);
    }
  }
}

// ---- confirming -----------------------------------------------------------------------------

async function confirm(ctx: Context, flow: SplitFlow, tapped: number): Promise<Note> {
  const { deps, member } = ctx;
  if (!(await claimConfirm(deps.db, flow, deps.now()))) return stale();

  const giveUp = async (message: string): Promise<Note> => {
    await releaseConfirm(deps.db, flow.id, deps.now());
    return alert(message);
  };

  const checked = checkSplit(flow.state, { memberIds: memberIds(ctx), today: ctx.today });
  if (!checked.ok) {
    await releaseConfirm(deps.db, flow.id, deps.now());
    const screen = renderProblem(
      screenFor(ctx, flow),
      Object.values(checked.errors)[0] ?? "Check the answers.",
    );
    await safely("edit", () =>
      deps.api.editMessage(ctx.chatId, tapped, screen.text, screen.keyboard),
    );
    return alert("Something needs fixing before I can add it.");
  }

  const store = createLedgerStore({
    db: deps.db,
    session: { userId: member.userId, groupId: member.groupId },
    fx: deps.fx,
    now: deps.now,
  });
  let created;
  try {
    created = await store.createExpense(checked.expense);
  } catch (error) {
    if (error instanceof RateUnavailableError) {
      return giveUp(
        `I cannot get a ${error.currency} to SGD rate for ${error.date} right now. Try Confirm again in a moment, or set the rate with /rate.`,
      );
    }
    if (error instanceof LedgerError) return giveUp(error.message);
    await releaseConfirm(deps.db, flow.id, deps.now());
    throw error;
  }

  await deleteFlow(deps.db, flow.id);
  const added = renderAdded(screenFor(ctx, flow), checked.expense, {
    appUrl: deps.config.appUrl,
    expenseId: created.id,
  });
  await safely("edit", () => deps.api.editMessage(ctx.chatId, tapped, added.text, added.keyboard));
  // The group hears about it exactly as it does for an expense added in the web form.
  await deps.notifier.expenseAdded(member.groupId, member.userId, created);
  return { text: "Added", alert: false };
}
