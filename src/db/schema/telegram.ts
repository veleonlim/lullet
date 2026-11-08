import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./_shared";
import { imports } from "./imports";
import { groups, memberships } from "./identity";

/**
 * Telegram updates already handled. Telegram redelivers an update when a webhook answers late or
 * with an error; claiming the id first (an insert that can only succeed once) makes the bot do
 * each update exactly once.
 */
export const telegramUpdates = pgTable(
  "telegram_updates",
  {
    updateId: bigint("update_id", { mode: "number" }).primaryKey(),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [index("telegram_updates_received_idx").on(t.receivedAt)],
);

/**
 * The one chat message that shows a draft (summary, row editor or result) and what it currently
 * shows, so a typed reply (percentages) knows which row it is for. Callback buttons carry their
 * own draft id; this table is only for replies.
 */
export const telegramDrafts = pgTable(
  "telegram_drafts",
  {
    importId: uuid("import_id")
      .primaryKey()
      .references(() => imports.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    /** "summary", "result" or "row:<index>". */
    view: text().notNull().default("summary"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("telegram_drafts_message_key").on(t.chatId, t.messageId)],
);

/**
 * Extra names a member answers to in a screenshot caption ("split between mum and dad"). A
 * member's display name and first name always work without a row here.
 */
export const memberAliases = pgTable(
  "member_aliases",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    /** Lower case, single spaces. */
    alias: text().notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.alias] }),
    foreignKey({
      name: "member_aliases_membership_fk",
      columns: [t.groupId, t.userId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }).onDelete("cascade"),
    check(
      "member_aliases_alias_check",
      sql`${t.alias} = lower(btrim(${t.alias})) AND char_length(${t.alias}) BETWEEN 2 AND 30`,
    ),
  ],
);

/**
 * A /split conversation in progress: the manual way to add an expense by answering the bot's
 * questions in a private chat. Vercel functions keep no memory between requests, so the answers so
 * far live here. A member has at most one open flow; starting /split again replaces it, and a flow
 * nobody answers expires (`expires_at`). `step` and `state` are written by the bot and validated
 * when read; `version` makes two taps that race on the same flow take turns.
 */
export const telegramSplitFlows = pgTable(
  "telegram_split_flows",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    userId: uuid("user_id").notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    /** The message that shows the current question, so a tap can be matched to it. */
    messageId: bigint("message_id", { mode: "number" }),
    step: text().notNull(),
    state: jsonb().notNull(),
    version: integer().notNull().default(0),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("telegram_split_flows_member_key").on(t.groupId, t.userId),
    foreignKey({
      name: "telegram_split_flows_membership_fk",
      columns: [t.groupId, t.userId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }).onDelete("cascade"),
    index("telegram_split_flows_expires_idx").on(t.expiresAt),
  ],
);
