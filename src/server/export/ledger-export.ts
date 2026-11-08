import { asc } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import { buildExportFiles, type ExportData, type ExportFile } from "@/lib/export/ledger-csv";

/**
 * Reads every ledger table in one read-only transaction (so the files agree with each other even
 * while the family is adding expenses) and turns them into CSV files. Nothing is written to the
 * database. Screenshot bytes are not part of it; they stay in the bucket.
 */
export async function exportLedger(db: Database): Promise<ExportFile[]> {
  const data: ExportData = await db.transaction(
    async (tx) => ({
      users: await tx.select().from(s.users).orderBy(asc(s.users.createdAt)),
      groups: await tx.select().from(s.groups).orderBy(asc(s.groups.createdAt)),
      memberships: await tx.select().from(s.memberships),
      telegramLinks: await tx.select().from(s.telegramLinks),
      expenses: await tx.select().from(s.expenses),
      expensePayers: await tx.select().from(s.expensePayers),
      expenseShares: await tx.select().from(s.expenseShares),
      settlements: await tx.select().from(s.settlements),
      budgets: await tx.select().from(s.budgets),
      dailyRates: await tx.select().from(s.dailyRates),
      fxRates: await tx.select().from(s.fxRates),
      auditLog: await tx.select().from(s.auditLog).orderBy(asc(s.auditLog.id)),
    }),
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
  return buildExportFiles(data);
}
