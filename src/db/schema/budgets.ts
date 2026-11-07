import { sql } from "drizzle-orm";
import { check, date, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { minorUnits, timestamptz } from "./_shared";
import { groups, users } from "./identity";

/**
 * The group's daily budget in SGD minor units. One row with a null `day` is the
 * default; a row with a date overrides that single day.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    day: date({ mode: "string" }),
    amountMinor: minorUnits("amount_minor").notNull(),
    setBy: uuid("set_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("budgets_group_day_key").on(t.groupId, t.day).nullsNotDistinct(),
    check("budgets_amount_check", sql`${t.amountMinor} >= 0`),
  ],
);
