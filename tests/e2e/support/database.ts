import { createDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { resetLedger, seedDevelopmentData } from "@/db/seed";

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("End to end tests need DATABASE_URL (see the README: docker compose up -d).");
  }
  return url;
}

/** Migrates the database and makes sure the four members and the trip group exist. */
export async function prepareDatabase(): Promise<void> {
  const { db, pool } = createDatabase({ connectionString: connectionString(), max: 1 });
  try {
    await runMigrations(db);
    await seedDevelopmentData(db);
  } finally {
    await pool.end();
  }
}

/** Empties the ledger so a test starts from nothing but the seeded people and rates. */
export async function resetLedgerData(): Promise<void> {
  const { db, pool } = createDatabase({ connectionString: connectionString(), max: 1 });
  try {
    await resetLedger(db);
  } finally {
    await pool.end();
  }
}
