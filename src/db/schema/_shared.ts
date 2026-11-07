import { bigint, char, pgEnum, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Integer minor units (cents). `mode: "number"` is safe: amounts stay far below 2^53. */
export const minorUnits = (name: string) => bigint(name, { mode: "number" });

/** ISO 4217 alpha-3 code. Which codes are supported lives in the money library. */
export const currencyCode = (name: string) => char(name, { length: 3 });

export const CURRENCY_FORMAT = (column: string) => sql.raw(`${column} ~ '^[A-Z]{3}$'`);

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const expenseCategory = pgEnum("expense_category", [
  "food",
  "transport",
  "stay",
  "sightseeing",
  "shopping",
  "other",
]);

export const splitMethod = pgEnum("split_method", ["equal", "exact", "percent", "shares"]);
