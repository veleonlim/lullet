import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { SEED_GROUP_ID, SEED_MEMBERS } from "./seed-ids";
import * as s from "./schema";

/**
 * Local development and end to end test data: one trip group with the four members
 * (in their fixed order) and stand-in market exchange rates, so the app works offline.
 * Everything is idempotent and only ever written to a database you point it at.
 */

/** SGD per 1 unit, the same on every seeded day so test arithmetic stays simple. */
export const SEED_RATES = { EUR: "1.5", CHF: "1.6" } as const;

/** Days with stand-in rates: the trip window and a margin either side. */
export const SEED_RATE_DAYS = { from: "2026-10-25", to: "2026-12-06" } as const;

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export async function seedDevelopmentData(db: Database): Promise<void> {
  await db
    .insert(s.users)
    .values(SEED_MEMBERS.map((member) => ({ id: member.id, displayName: member.displayName })))
    .onConflictDoNothing();
  await db
    .insert(s.groups)
    .values({ id: SEED_GROUP_ID, name: "Switzerland and Italy" })
    .onConflictDoNothing();
  await db
    .insert(s.memberships)
    .values(
      SEED_MEMBERS.map((member, position) => ({
        groupId: SEED_GROUP_ID,
        userId: member.id,
        position,
      })),
    )
    .onConflictDoNothing();

  const rows = daysBetween(SEED_RATE_DAYS.from, SEED_RATE_DAYS.to).flatMap((rateDate) =>
    (Object.entries(SEED_RATES) as [keyof typeof SEED_RATES, string][]).map(([base, rate]) => ({
      rateDate,
      base,
      quote: "SGD",
      rate,
      sourceDate: rateDate,
      provider: "seed",
    })),
  );
  await db.insert(s.fxRates).values(rows).onConflictDoNothing();
}

/**
 * Removes every expense, settlement, audit entry and day rate (keeps people and market
 * rates) so a test or a demo starts from an empty ledger. TRUNCATE skips the row triggers
 * that make these tables append only, which is what makes a reset possible at all.
 */
export async function resetLedger(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE expense_payers, expense_shares, expenses, settlements, audit_log, daily_rates RESTART IDENTITY CASCADE`,
  );
}
