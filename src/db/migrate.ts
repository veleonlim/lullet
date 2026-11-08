import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

/** Applies every pending migration in ./drizzle. Safe to run repeatedly. */
export async function runMigrations(db: Database, migrationsFolder = "./drizzle"): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/** How many migrations in the folder the database has not applied yet. */
export async function countPendingMigrations(
  db: Database,
  migrationsFolder = "./drizzle",
): Promise<number> {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  const present = await db.execute<{ found: string | null }>(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS found`,
  );
  if (present.rows[0]?.found == null) return journal.entries.length;
  const applied = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
  );
  return Math.max(0, journal.entries.length - Number(applied.rows[0]?.count ?? "0"));
}
