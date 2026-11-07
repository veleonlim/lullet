import { Client } from "pg";
import { createDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { seedDevelopmentData } from "@/db/seed";

/**
 * Creates the end to end database if it does not exist yet, brings it up to date and makes
 * sure the seeded trip group (the four ledger members) exists.
 */
export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: process.env.E2E_ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'lullet_e2e'");
    if (exists.rowCount === 0) await admin.query("CREATE DATABASE lullet_e2e");
  } finally {
    await admin.end();
  }

  const connectionString = process.env.E2E_DATABASE_URL;
  if (!connectionString) throw new Error("E2E_DATABASE_URL is not set");
  const { db, pool } = createDatabase({ connectionString, max: 1 });
  try {
    await runMigrations(db);
    await seedDevelopmentData(db);
  } finally {
    await pool.end();
  }
}
