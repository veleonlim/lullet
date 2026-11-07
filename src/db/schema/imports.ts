import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currencyCode, expenseCategory, minorUnits, timestamptz } from "./_shared";
import { groups, memberships } from "./identity";

export const importSource = pgEnum("import_source", ["telegram", "web"]);
export const importStatus = pgEnum("import_status", [
  "draft",
  "confirmed",
  "cancelled",
  "expired",
  "undone",
]);

/**
 * One uploaded screenshot and its draft. Drafts never reach balances or dashboards:
 * only confirming an import creates expenses. Only the uploader confirms.
 */
export const imports = pgTable(
  "imports",
  {
    id: uuid().primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    uploaderId: uuid("uploader_id").notNull(),
    source: importSource().notNull(),
    status: importStatus().notNull().default("draft"),
    /** SHA-256 of the original image, lowercase hex. Identical re-uploads are rejected. */
    imageSha256: char("image_sha256", { length: 64 }).notNull(),
    /** Object storage key of the original. Cleared when it is deleted after the retention period. */
    storageKey: text("storage_key"),
    imageDeletedAt: timestamptz("image_deleted_at"),
    caption: text(),
    /** Model that produced the draft, for example claude-haiku-5-5. */
    model: text(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at"),
    confirmedAt: timestamptz("confirmed_at"),
    undoneAt: timestamptz("undone_at"),
  },
  (t) => [
    foreignKey({
      name: "imports_uploader_membership_fk",
      columns: [t.groupId, t.uploaderId],
      foreignColumns: [memberships.groupId, memberships.userId],
    }),
    uniqueIndex("imports_group_image_active_key")
      .on(t.groupId, t.imageSha256)
      .where(sql`${t.status} IN ('draft', 'confirmed')`),
    index("imports_group_created_idx").on(t.groupId, t.createdAt),
    check("imports_sha256_check", sql`${t.imageSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "imports_confirmed_check",
      sql`${t.status} NOT IN ('confirmed', 'undone') OR ${t.confirmedAt} IS NOT NULL`,
    ),
    check("imports_undone_check", sql`(${t.status} = 'undone') = (${t.undoneAt} IS NOT NULL)`),
  ],
);

/** One extracted transaction of an import, exactly as read plus what our code made of it. */
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid().primaryKey().defaultRandom(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    merchant: text(),
    amountText: text("amount_text"),
    amountMinor: minorUnits("amount_minor"),
    currency: currencyCode("currency"),
    billedAmountText: text("billed_amount_text"),
    billedAmountMinor: minorUnits("billed_amount_minor"),
    billedCurrency: currencyCode("billed_currency"),
    spentOn: date("spent_on", { mode: "string" }),
    category: expenseCategory(),
    /** Model confidence 0 to 100; low becomes "other" plus a check chip. */
    categoryConfidence: smallint("category_confidence"),
    /** Unchecked rows are left out when confirming. */
    included: boolean().notNull().default(true),
    /** Flags such as uncertain, unreadable or possible_duplicate. */
    issues: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Draft payer and split choices before they become expense rows. */
    draftSplit: jsonb("draft_split"),
  },
  (t) => [
    unique("import_rows_import_position_key").on(t.importId, t.position),
    check("import_rows_amount_check", sql`${t.amountMinor} IS NULL OR ${t.amountMinor} > 0`),
    check("import_rows_currency_check", sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "import_rows_billed_check",
      sql`(${t.billedAmountMinor} IS NULL OR ${t.billedAmountMinor} > 0)
        AND (${t.billedCurrency} IS NULL OR ${t.billedCurrency} ~ '^[A-Z]{3}$')`,
    ),
    check(
      "import_rows_confidence_check",
      sql`${t.categoryConfidence} IS NULL OR ${t.categoryConfidence} BETWEEN 0 AND 100`,
    ),
  ],
);
