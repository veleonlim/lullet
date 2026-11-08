import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";

/**
 * Integration tests run against a real Postgres (the compose.yaml service locally,
 * a service container in CI). Each run gets its own freshly migrated database so
 * runs never see each other's data, and the database is dropped afterwards.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "Integration tests need DATABASE_URL pointing at a Postgres server (see README: `docker compose up -d`).",
    );
  }

  const name = `lullet_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  process.env.TEST_DATABASE_URL = url.toString();
  // The bot's member lookup resolves the process wide session secret even when it only reads the
  // allowlist, so the suite needs one (CI sets only DATABASE_URL). A made-up value, never a real secret.
  process.env.SESSION_SECRET ??= "integration-session-secret-0123456789abcdef";

  const { db, pool } = createDatabase({ connectionString: url.toString(), max: 2 });
  try {
    await runMigrations(db);
  } finally {
    await pool.end();
  }

  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };
}
