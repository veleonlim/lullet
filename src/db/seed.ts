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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True only when the connection string names a local host (the CI service container is localhost). */
export function isLocalDatabaseUrl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return !url.searchParams.has("host") && LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Throws unless the database is local; seed data and resets must never reach a shared database. */
export function assertLocalDatabase(connectionString: string, action: string): void {
  if (!isLocalDatabaseUrl(connectionString)) {
    throw new Error(
      `Refusing to ${action}: the database host is not local (localhost, 127.0.0.1 or ::1). ` +
        "Point DATABASE_URL at a local development database.",
    );
  }
}

export async function seedDevelopmentData(db: Database, connectionString: string): Promise<void> {
  assertLocalDatabase(connectionString, "seed development data");
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
        isOwner: position === 0,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(s.telegramLinks)
    .values(
      SEED_MEMBERS.map((member) => ({
        userId: member.id,
        telegramUserId: member.telegramUserId,
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
 * Removes every expense, settlement, audit entry, day rate and budget, and resets the trip dates (keeps people and market
 * rates) so a test or a demo starts from an empty ledger. TRUNCATE skips the row triggers
 * that make these tables append only, which is what makes a reset possible at all.
 * It refuses any database whose host is not local, so it can never wipe a shared ledger.
 */
export async function resetLedger(db: Database, connectionString: string): Promise<void> {
  assertLocalDatabase(connectionString, "reset the ledger");
  await db.execute(
    sql`TRUNCATE TABLE expense_payers, expense_shares, expenses, settlements, import_rows, imports, audit_log, daily_rates, budgets RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`UPDATE groups SET trip_start = NULL, trip_end = NULL, time_zone = 'Europe/Zurich'`,
  );
}
