import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

/** Applies every pending migration in ./drizzle. Safe to run repeatedly. */
export async function runMigrations(db: Database, migrationsFolder = "./drizzle"): Promise<void> {
  await migrate(db, { migrationsFolder });
}
