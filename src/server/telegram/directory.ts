import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import { listMembers, type MemberRow } from "@/lib/auth/db/members";
import { normalizeAlias } from "@/lib/telegram/caption";
import type { Person } from "@/lib/telegram/render";

/** Database lookups the bot needs: who is on the allowlist, aliases, handled updates, draft messages. */

export interface Person2 extends Person {
  readonly position: number;
  readonly telegramUserId: number | null;
  readonly telegramUsername: string | null;
}

/** Telegram ids of everyone on the allowlist (the `telegram_links` table, shared with sign-in). */
export async function allowedTelegramIds(db: Database): Promise<Set<number>> {
  const rows = await db
    .select({ id: s.telegramLinks.telegramUserId })
    .from(s.telegramLinks)
    .innerJoin(s.memberships, eq(s.memberships.userId, s.telegramLinks.userId));
  return new Set(rows.map((row) => row.id));
}

export async function people(db: Database, groupId: string): Promise<Person2[]> {
  const rows: MemberRow[] = await listMembers(groupId, { db });
  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    position: row.position,
    telegramUserId: row.telegramUserId,
    telegramUsername: row.telegramUsername,
  }));
}

export async function customAliases(
  db: Database,
  groupId: string,
): Promise<{ alias: string; userId: string }[]> {
  return db
    .select({ alias: s.memberAliases.alias, userId: s.memberAliases.userId })
    .from(s.memberAliases)
    .where(eq(s.memberAliases.groupId, groupId))
    .orderBy(s.memberAliases.createdAt);
}

export type AddAliasResult = "added" | "taken" | "invalid";

export async function addAlias(
  db: Database,
  groupId: string,
  userId: string,
  alias: string,
): Promise<AddAliasResult> {
  const key = normalizeAlias(alias);
  if (key.length < 2 || key.length > 30) return "invalid";
  const inserted = await db
    .insert(s.memberAliases)
    .values({ groupId, alias: key, userId })
    .onConflictDoNothing()
    .returning({ alias: s.memberAliases.alias });
  return inserted.length > 0 ? "added" : "taken";
}

const UPDATE_KEEP_MS = 7 * 24 * 3_600_000;

/** True the first time an update id is seen; a redelivery gets false and must be skipped. */
export async function claimUpdate(db: Database, updateId: number, now: Date): Promise<boolean> {
  await db
    .delete(s.telegramUpdates)
    .where(lt(s.telegramUpdates.receivedAt, new Date(now.getTime() - UPDATE_KEEP_MS)));
  const claimed = await db
    .insert(s.telegramUpdates)
    .values({ updateId, receivedAt: now })
    .onConflictDoNothing()
    .returning({ id: s.telegramUpdates.updateId });
  return claimed.length > 0;
}

export type DraftScreen = "summary" | "result" | `row:${number}`;

export async function trackDraftMessage(
  db: Database,
  importId: string,
  chatId: number,
  messageId: number,
  view: DraftScreen,
  now: Date,
): Promise<void> {
  await db
    .insert(s.telegramDrafts)
    .values({ importId, chatId, messageId, view, updatedAt: now })
    .onConflictDoUpdate({
      target: s.telegramDrafts.importId,
      set: { chatId, messageId, view, updatedAt: now },
    });
}

export async function findTrackedDraft(
  db: Database,
  chatId: number,
  messageId: number,
): Promise<{ importId: string; view: string } | null> {
  const [row] = await db
    .select({ importId: s.telegramDrafts.importId, view: s.telegramDrafts.view })
    .from(s.telegramDrafts)
    .where(and(eq(s.telegramDrafts.chatId, chatId), eq(s.telegramDrafts.messageId, messageId)));
  return row ?? null;
}

export function parseRowView(view: string): number | null {
  const match = /^row:(\d{1,3})$/.exec(view);
  return match ? Number(match[1]) : null;
}

/** Telegram ids to message for a set of members. */
export async function telegramIdsFor(
  db: Database,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: s.telegramLinks.userId, id: s.telegramLinks.telegramUserId })
    .from(s.telegramLinks)
    .where(inArray(s.telegramLinks.userId, [...userIds]));
  return new Map(rows.map((row) => [row.userId, row.id]));
}

export async function setDayRate(
  db: Database,
  input: {
    groupId: string;
    userId: string;
    currency: string;
    rate: string;
    day: string;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ rate: s.dailyRates.rate })
      .from(s.dailyRates)
      .where(
        and(
          eq(s.dailyRates.groupId, input.groupId),
          eq(s.dailyRates.rateDate, input.day),
          eq(s.dailyRates.base, input.currency),
          eq(s.dailyRates.quote, "SGD"),
        ),
      );
    await tx
      .insert(s.dailyRates)
      .values({
        groupId: input.groupId,
        rateDate: input.day,
        base: input.currency,
        quote: "SGD",
        rate: input.rate,
        setBy: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [
          s.dailyRates.groupId,
          s.dailyRates.rateDate,
          s.dailyRates.base,
          s.dailyRates.quote,
        ],
        set: { rate: input.rate, setBy: input.userId, updatedAt: input.now },
      });
    await tx.insert(s.auditLog).values({
      groupId: input.groupId,
      actorUserId: input.userId,
      action: "daily_rate.set",
      entityType: "daily_rate",
      before: before ? { day: input.day, currency: input.currency, rate: before.rate } : null,
      after: { day: input.day, currency: input.currency, rate: input.rate },
    });
  });
}

export async function dayRates(
  db: Database,
  groupId: string,
  day: string,
): Promise<{ currency: string; rate: string }[]> {
  const rows = await db
    .select({ currency: s.dailyRates.base, rate: s.dailyRates.rate })
    .from(s.dailyRates)
    .where(and(eq(s.dailyRates.groupId, groupId), eq(s.dailyRates.rateDate, day)))
    .orderBy(sql`${s.dailyRates.base}`);
  return rows;
}
