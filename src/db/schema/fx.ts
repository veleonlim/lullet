import { sql } from "drizzle-orm";
import { check, date, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { currencyCode, timestamptz } from "./_shared";
import { groups, users } from "./identity";

/**
 * Market rates, stored the first time a day is needed so history never moves when
 * the market does. Immutable: rows are only ever inserted. `rate` is units of
 * `quote` per 1 unit of `base`.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    rateDate: date("rate_date", { mode: "string" }).notNull(),
    base: currencyCode("base").notNull(),
    quote: currencyCode("quote").notNull(),
    rate: numeric({ precision: 20, scale: 10 }).notNull(),
    /** The day the provider's rate is actually from (earlier than rate_date on weekends). */
    sourceDate: date("source_date", { mode: "string" }).notNull(),
    provider: text().notNull().default("frankfurter"),
    fetchedAt: timestamptz("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.rateDate, t.base, t.quote] }),
    check(
      "fx_rates_pair_check",
      sql`${t.base} ~ '^[A-Z]{3}$' AND ${t.quote} ~ '^[A-Z]{3}$' AND ${t.base} <> ${t.quote}`,
    ),
    check("fx_rates_rate_check", sql`${t.rate} > 0`),
    check("fx_rates_source_date_check", sql`${t.sourceDate} <= ${t.rateDate}`),
  ],
);

/**
 * A group's default exchange rate for one day (the "per-day default rate"). Beats the
 * market rate in the conversion precedence; the billed SGD figure and a rate set on
 * a single expense still beat it.
 */
export const dailyRates = pgTable(
  "daily_rates",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id),
    rateDate: date("rate_date", { mode: "string" }).notNull(),
    base: currencyCode("base").notNull(),
    quote: currencyCode("quote").notNull().default("SGD"),
    rate: numeric({ precision: 20, scale: 10 }).notNull(),
    setBy: uuid("set_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.rateDate, t.base, t.quote] }),
    check(
      "daily_rates_pair_check",
      sql`${t.base} ~ '^[A-Z]{3}$' AND ${t.quote} ~ '^[A-Z]{3}$' AND ${t.base} <> ${t.quote}`,
    ),
    check("daily_rates_rate_check", sql`${t.rate} > 0`),
  ],
);
