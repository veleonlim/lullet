import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./_shared";

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  displayName: text().notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const groups = pgTable(
  "groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    /** First and last calendar day of the trip. Both are optional: the dashboard falls back to the days that have expenses. */
    tripStart: date("trip_start", { mode: "string" }),
    tripEnd: date("trip_end", { mode: "string" }),
    /** IANA time zone the trip runs in; decides which calendar day "today" is for budgets. */
    timeZone: text("time_zone").notNull().default("Europe/Zurich"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "groups_trip_range_check",
      sql`${t.tripStart} IS NULL OR ${t.tripEnd} IS NULL OR ${t.tripEnd} >= ${t.tripStart}`,
    ),
  ],
);

/**
 * Who is in a group. `position` is the group's fixed member order: it decides who
 * gets the spare cent when an amount does not divide evenly, so it must be stable.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    position: smallint().notNull(),
    /** The one member who may re-bind another member's Telegram account (see `auth.ts`). */
    isOwner: boolean("is_owner").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_one_owner_per_group_idx")
      .on(t.groupId)
      .where(sql`${t.isOwner}`),
    // Also the target of composite foreign keys that prove a user belongs to the group.
    unique("memberships_group_user_key").on(t.groupId, t.userId),
    unique("memberships_group_position_key").on(t.groupId, t.position),
    check("memberships_position_check", sql`${t.position} >= 0`),
  ],
);

/** Links an app user to a Telegram identity (the sign-in method, and where the bot replies). */
export const telegramLinks = pgTable(
  "telegram_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull().unique(),
    privateChatId: bigint("private_chat_id", { mode: "number" }),
    username: text(),
    linkedAt: timestamptz("linked_at").notNull().defaultNow(),
  },
  (t) => [check("telegram_links_ids_check", sql`${t.telegramUserId} > 0`)],
);
