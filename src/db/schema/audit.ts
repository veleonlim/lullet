import { bigint, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./_shared";
import { groups, users } from "./identity";

/**
 * Append-only record of every ledger change (the database rejects UPDATE and DELETE).
 * `before` and `after` hold the row as JSON so an edit or delete can be reconstructed.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    groupId: uuid("group_id").references(() => groups.id),
    /** Null when the system acted (a scheduled job, for example). */
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text().notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb(),
    after: jsonb(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_group_created_idx").on(t.groupId, t.createdAt),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
  ],
);
