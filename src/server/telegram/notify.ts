import type { Database } from "@/db/client";
import type { StoredExpense } from "@/lib/ledger/types";
import {
  announceExpenseAdded,
  announceImportConfirmed,
  notifyExpenseDeleted,
  notifyExpenseEdited,
  notifyImportUndone,
  type ExpenseBrief,
} from "@/lib/telegram/announce";
import { describeFailure, type BotApi } from "./api";
import type { BotConfig } from "./config";
import { people, telegramIdsFor } from "./directory";

/**
 * What the bot tells people when the ledger changes (decision D6): a short post in the group when
 * an import or a manual expense is added, and a private message to each member affected when an
 * expense they are part of is edited or deleted (or an import is undone). Every method is best
 * effort: Telegram being down or a member never having started the bot must not fail the change
 * that has already been saved.
 */
export interface Notifier {
  importConfirmed(
    groupId: string,
    actorId: string,
    expenses: readonly StoredExpense[],
  ): Promise<void>;
  expenseAdded(groupId: string, actorId: string, expense: StoredExpense): Promise<void>;
  expenseEdited(
    groupId: string,
    actorId: string,
    before: StoredExpense,
    after: StoredExpense,
  ): Promise<void>;
  expenseDeleted(groupId: string, actorId: string, expense: StoredExpense): Promise<void>;
  importUndone(groupId: string, actorId: string, expenses: readonly StoredExpense[]): Promise<void>;
}

export const noopNotifier: Notifier = {
  importConfirmed: () => Promise.resolve(),
  expenseAdded: () => Promise.resolve(),
  expenseEdited: () => Promise.resolve(),
  expenseDeleted: () => Promise.resolve(),
  importUndone: () => Promise.resolve(),
};

export function briefOf(expense: StoredExpense): ExpenseBrief {
  return {
    id: expense.id,
    description: expense.description,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    spentOn: expense.spentOn,
  };
}

function involved(expense: StoredExpense): string[] {
  return [...expense.payers.map((p) => p.userId), ...expense.shares.map((s) => s.userId)];
}

export function createNotifier(options: {
  readonly db: Database;
  readonly api: BotApi;
  readonly config: BotConfig;
}): Notifier {
  const { db, api, config } = options;

  async function attempt(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (error) {
      console.error("Telegram notification failed", describeFailure(error));
    }
  }

  async function nameOf(groupId: string, userId: string): Promise<string> {
    return (await people(db, groupId)).find((p) => p.userId === userId)?.displayName ?? "Someone";
  }

  /** Private message to everyone in `userIds` except the person who made the change. */
  async function tell(userIds: readonly string[], actorId: string, html: string): Promise<void> {
    const targets = [...new Set(userIds)].filter((id) => id !== actorId);
    const ids = await telegramIdsFor(db, targets);
    for (const telegramId of ids.values()) {
      await attempt(() => api.sendMessage(telegramId, html, { noLinkPreview: true }));
    }
  }

  return {
    async importConfirmed(groupId, actorId, expenses) {
      await attempt(async () => {
        if (expenses.length === 0) return;
        const actor = await nameOf(groupId, actorId);
        await api.sendMessage(
          config.groupChatId,
          announceImportConfirmed(actor, expenses.map(briefOf)),
        );
      });
    },
    async expenseAdded(groupId, actorId, expense) {
      await attempt(async () => {
        const members = await people(db, groupId);
        const name = (id: string) => members.find((m) => m.userId === id)?.displayName ?? "Someone";
        const payers = expense.payers.map((p) => name(p.userId)).join(", ");
        await api.sendMessage(
          config.groupChatId,
          announceExpenseAdded(name(actorId), briefOf(expense), payers),
        );
      });
    },
    async expenseEdited(groupId, actorId, before, after) {
      await attempt(async () => {
        const actor = await nameOf(groupId, actorId);
        const link = `${config.appUrl}/expenses/${after.id}`;
        await tell(
          [...involved(before), ...involved(after)],
          actorId,
          notifyExpenseEdited(actor, briefOf(before), briefOf(after), link),
        );
      });
    },
    async expenseDeleted(groupId, actorId, expense) {
      await attempt(async () => {
        const actor = await nameOf(groupId, actorId);
        await tell(involved(expense), actorId, notifyExpenseDeleted(actor, briefOf(expense)));
      });
    },
    async importUndone(groupId, actorId, expenses) {
      await attempt(async () => {
        if (expenses.length === 0) return;
        const actor = await nameOf(groupId, actorId);
        await tell(
          expenses.flatMap(involved),
          actorId,
          notifyImportUndone(actor, expenses.map(briefOf)),
        );
      });
    },
  };
}
