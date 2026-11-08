/**
 * `pnpm export:csv` saves the whole ledger as CSV files on your computer, a backup you can open in
 * a spreadsheet without lullet or the database.
 *
 *   pnpm export:csv                    into exports/lullet-export-<date and time>/
 *   pnpm export:csv --out ~/Documents/lullet-backup-1
 *
 * Read-only: it never changes the database. Uses DATABASE_URL_UNPOOLED when set, else
 * DATABASE_URL. The files contain the family's spending and Telegram ids: keep them private.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { createDatabase } from "@/db/client";
import { describeDatabaseTarget } from "@/db/migration-target";
import { exportLedger } from "@/server/export/ledger-export";
import { exportFolderName, writeExport } from "@/server/export/write";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (see docs/ENVIRONMENT.md).");
    return 1;
  }
  const directory = path.resolve(values.out ?? path.join("exports", exportFolderName(new Date())));
  console.log(`Database: ${describeDatabaseTarget(connectionString)}`);

  const { db, pool } = createDatabase({ connectionString, max: 1 });
  try {
    const files = await exportLedger(db);
    await writeExport(directory, files);
    for (const file of files) {
      console.log(`  ${file.name.padEnd(20)} ${String(file.rows).padStart(6)} rows`);
    }
    console.log(`Saved to ${directory}`);
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
    console.error(error instanceof Error ? error.message : "Export failed");
    process.exitCode = 1;
  });
