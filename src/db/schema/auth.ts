import { foreignKey, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./_shared";
import { groups, memberships, users } from "./identity";

/**
 * Server-side sessions. The browser only holds an opaque random token; the table stores a keyed
 * hash of it, so a database leak does not hand out working sessions. A session belongs to a
 * member of one group; removing the membership ends the session.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "sessions_membership_fk",
      columns: [t.groupId, t.userId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }).onDelete("cascade"),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

/**
 * One-time browser login links, DMed by the bot. The token is stored hashed, expires quickly and is
 * consumed by an atomic conditional update, so a link works once even under concurrent requests.
 */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
  },
  (t) => [
    index("login_tokens_user_idx").on(t.userId),
    index("login_tokens_expires_idx").on(t.expiresAt),
  ],
);
