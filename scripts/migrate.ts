/**
 * `pnpm db:migrate:prod` applies the database migrations to production, as a deliberate step run
 * from your own computer. The app never migrates on start-up.
 *
 *   pnpm db:migrate:prod --dry-run   say how many migrations are waiting, change nothing
 *   pnpm db:migrate:prod             apply them
 *
 * It uses DATABASE_URL_UNPOOLED only (Neon's direct connection, not the pooler) and prints the
 * host and database it is about to change, never the password.
 */
import { createDatabase } from "@/db/client";
import { countPendingMigrations, runMigrations } from "@/db/migrate";
import { assertDirectUrl, describeDatabaseTarget } from "@/db/migration-target";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const connectionString = assertDirectUrl(process.env.DATABASE_URL_UNPOOLED);
  console.log(`Database: ${describeDatabaseTarget(connectionString)}`);

  const { db, pool } = createDatabase({ connectionString, max: 1 });
  try {
    const pending = await countPendingMigrations(db);
    console.log(`${String(pending)} migration(s) waiting.`);
    if (dryRun || pending === 0) {
      console.log(dryRun ? "Dry run: nothing was changed." : "Already up to date.");
      return 0;
    }
    await runMigrations(db);
    console.log("Migrations applied.");
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Print the message only: a driver error object can carry the connection string.
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  });
