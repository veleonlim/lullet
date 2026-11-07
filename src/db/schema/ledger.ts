import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { currencyCode, expenseCategory, minorUnits, splitMethod, timestamptz } from "./_shared";
import { groups, memberships, users } from "./identity";
import { importRows, imports } from "./imports";

/**
 * An expense in the currency shown on the receipt. Splits are stored in that
 * currency; SGD figures are always derived (see the money library), never stored.
 *
 * Invariants enforced by the database (see the invariants migration):
 *  - amounts are positive integer minor units
 *  - payer amounts add up to the expense amount, and so do share amounts
 *  - rows are soft-deleted (deleted_at/deleted_by), never removed
 */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    importId: uuid("import_id").references(() => imports.id),
    importRowId: uuid("import_row_id")
      .unique()
      .references(() => importRows.id),
    description: text().notNull(),
    category: expenseCategory().notNull().default("other"),
    /** The calendar day shown on the receipt. No time zone shifting. */
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    amountMinor: minorUnits("amount_minor").notNull(),
    currency: currencyCode("currency").notNull(),
    /** What the card was billed, when the receipt shows it (SGD when the bank converted). */
    billedAmountMinor: minorUnits("billed_amount_minor"),
    billedCurrency: currencyCode("billed_currency"),
    /** SGD per 1 unit of `currency`, when set on this single expense. */
    rate: numeric({ precision: 20, scale: 10 }),
    splitMethod: splitMethod("split_method").notNull().default("equal"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => users.id),
  },
  (t) => [
    unique("expenses_id_group_key").on(t.id, t.groupId),
    index("expenses_group_spent_on_idx")
      .on(t.groupId, t.spentOn)
      .where(sql`${t.deletedAt} IS NULL`),
    check("expenses_amount_check", sql`${t.amountMinor} > 0`),
    check("expenses_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "expenses_billed_check",
      sql`(${t.billedAmountMinor} IS NULL AND ${t.billedCurrency} IS NULL)
        OR (${t.billedAmountMinor} IS NOT NULL AND ${t.billedAmountMinor} > 0 AND ${t.billedCurrency} IS NOT NULL AND ${t.billedCurrency} ~ '^[A-Z]{3}$')`,
    ),
    check("expenses_rate_check", sql`${t.rate} IS NULL OR ${t.rate} > 0`),
    check("expenses_soft_delete_check", sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)`),
  ],
);

/** Who paid how much towards an expense. Several payers are allowed. */
export const expensePayers = pgTable(
  "expense_payers",
  {
    expenseId: uuid("expense_id").notNull(),
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
    amountMinor: minorUnits("amount_minor").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.userId] }),
    foreignKey({
      name: "expense_payers_expense_fk",
      columns: [t.expenseId, t.groupId],
      foreignColumns: [expenses.id, expenses.groupId],
    }).onDelete("cascade"),
    foreignKey({
      name: "expense_payers_membership_fk",
      columns: [t.groupId, t.userId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }),
    check("expense_payers_amount_check", sql`${t.amountMinor} > 0`),
  ],
);

/** Who owes how much of an expense. Absence means the person is not part of the split. */
export const expenseShares = pgTable(
  "expense_shares",
  {
    expenseId: uuid("expense_id").notNull(),
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
    amountMinor: minorUnits("amount_minor").notNull(),
    /** Basis points for percent splits, share count for share splits, null otherwise. */
    weight: integer(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.userId] }),
    foreignKey({
      name: "expense_shares_expense_fk",
      columns: [t.expenseId, t.groupId],
      foreignColumns: [expenses.id, expenses.groupId],
    }).onDelete("cascade"),
    foreignKey({
      name: "expense_shares_membership_fk",
      columns: [t.groupId, t.userId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }),
    check("expense_shares_amount_check", sql`${t.amountMinor} >= 0`),
    check("expense_shares_weight_check", sql`${t.weight} IS NULL OR ${t.weight} >= 0`),
  ],
);

/** One member paying another to reduce what is owed. Soft-deleted, like expenses. */
export const settlements = pgTable(
  "settlements",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    fromUserId: uuid("from_user_id").notNull(),
    toUserId: uuid("to_user_id").notNull(),
    amountMinor: minorUnits("amount_minor").notNull(),
    currency: currencyCode("currency").notNull(),
    billedAmountMinor: minorUnits("billed_amount_minor"),
    billedCurrency: currencyCode("billed_currency"),
    rate: numeric({ precision: 20, scale: 10 }),
    settledOn: date("settled_on", { mode: "string" }).notNull(),
    note: text(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => users.id),
  },
  (t) => [
    foreignKey({
      name: "settlements_from_membership_fk",
      columns: [t.groupId, t.fromUserId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }),
    foreignKey({
      name: "settlements_to_membership_fk",
      columns: [t.groupId, t.toUserId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }),
    index("settlements_group_settled_on_idx")
      .on(t.groupId, t.settledOn)
      .where(sql`${t.deletedAt} IS NULL`),
    check("settlements_parties_check", sql`${t.fromUserId} <> ${t.toUserId}`),
    check("settlements_amount_check", sql`${t.amountMinor} > 0`),
    check("settlements_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "settlements_billed_check",
      sql`(${t.billedAmountMinor} IS NULL AND ${t.billedCurrency} IS NULL)
        OR (${t.billedAmountMinor} IS NOT NULL AND ${t.billedAmountMinor} > 0 AND ${t.billedCurrency} IS NOT NULL AND ${t.billedCurrency} ~ '^[A-Z]{3}$')`,
    ),
    check("settlements_rate_check", sql`${t.rate} IS NULL OR ${t.rate} > 0`),
    check(
      "settlements_soft_delete_check",
      sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)`,
    ),
  ],
);
