import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/db/client";
import { countPendingMigrations, runMigrations } from "@/db/migrate";
import * as s from "@/db/schema";
import { exportLedger } from "@/server/export/ledger-export";
import { writeExport } from "@/server/export/write";
import { closeTestDb, insertExpense, resetDatabase, seedGroup, testDb } from "./helpers";

const db = testDb();

beforeEach(() => resetDatabase(db));
afterAll(closeTestDb);

describe("the CSV export", () => {
  it("exports a real ledger, deleted rows and the audit trail included, and changes nothing", async () => {
    const seed = await seedGroup(db);
    const [alex = "", mei = ""] = seed.userIds;
    const kept = await insertExpense(db, {
      seed,
      amountMinor: 14849,
      payers: [{ userId: alex, amountMinor: 14849 }],
      shares: seed.userIds.map((userId, i) => ({ userId, amountMinor: i === 0 ? 3713 : 3712 })),
    });
    const removed = await insertExpense(db, {
      seed,
      amountMinor: 1000,
      currency: "CHF",
      payers: [{ userId: mei, amountMinor: 1000 }],
      shares: seed.userIds.map((userId) => ({ userId, amountMinor: 250 })),
    });
    await db
      .update(s.expenses)
      .set({ deletedAt: new Date(), deletedBy: mei })
      .where(sql`id = ${removed}`);
    await db.insert(s.auditLog).values({
      groupId: seed.groupId,
      actorUserId: alex,
      action: "expense.create",
      entityType: "expense",
      entityId: kept,
      after: { description: "Trattoria" },
    });

    const before = (await db.execute(sql`SELECT count(*)::int AS n FROM expenses`)).rows;
    const files = await exportLedger(db);
    const byName = new Map(files.map((file) => [file.name, file]));

    expect(byName.get("members.csv")?.rows).toBe(4);
    expect(byName.get("expenses.csv")?.rows).toBe(2);
    expect(byName.get("expense_payers.csv")?.rows).toBe(2);
    expect(byName.get("expense_shares.csv")?.rows).toBe(8);
    expect(byName.get("audit_log.csv")?.rows).toBeGreaterThanOrEqual(1);

    const expenses = byName.get("expenses.csv")?.content ?? "";
    expect(expenses).toContain("148.49,EUR,14849");
    expect(expenses).toContain("10.00,CHF,1000");
    expect(expenses).toContain("Trattoria");
    expect(expenses).toContain("Member 1 148.49");
    expect(expenses).toContain("Member 1 37.13; Member 2 37.12");
    expect(byName.get("audit_log.csv")?.content).toContain('"{""description"":""Trattoria""}"');

    expect((await db.execute(sql`SELECT count(*)::int AS n FROM expenses`)).rows).toEqual(before);

    const directory = await mkdtemp(path.join(os.tmpdir(), "lullet-export-it-"));
    try {
      const target = path.join(directory, "out");
      await writeExport(target, files);
      expect(await readFile(path.join(target, "expenses.csv"), "utf8")).toBe(expenses);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exports an empty database as header-only files", async () => {
    const files = await exportLedger(db);
    expect(files.every((file) => file.rows === 0)).toBe(true);
  });
});

describe("counting pending migrations", () => {
  it("counts what a database has not applied yet, in a database of its own", async () => {
    const adminUrl = process.env.DATABASE_URL ?? "";
    const name = `lullet_pending_${randomBytes(6).toString("hex")}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const { db: scratch, pool } = createDatabase({ connectionString: url.toString(), max: 1 });
    try {
      const total = (
        JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8")) as { entries: unknown[] }
      ).entries.length;
      expect(await countPendingMigrations(scratch)).toBe(total);

      await runMigrations(scratch);
      expect(await countPendingMigrations(scratch)).toBe(0);

      await scratch.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations
            WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`,
      );
      expect(await countPendingMigrations(scratch)).toBe(1);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
