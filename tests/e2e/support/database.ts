import { createDatabase } from "@/db/client";
import { resetLedger } from "@/db/seed";

/** Empties the ledger so a test starts from nothing but the seeded people and rates. */
export async function resetLedgerData(): Promise<void> {
  const connectionString = process.env.E2E_DATABASE_URL;
  if (!connectionString) throw new Error("E2E_DATABASE_URL is not set (see playwright.config.ts).");
  const { db, pool } = createDatabase({ connectionString, max: 1 });
  try {
    await resetLedger(db, connectionString);
  } finally {
    await pool.end();
  }
}
