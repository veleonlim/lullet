import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "@/db/migrate";
import { closeTestDb, testDb } from "./helpers";

const CORE_TABLES = [
  "audit_log",
  "budgets",
  "daily_rates",
  "expense_payers",
  "expense_shares",
  "expenses",
  "fx_rates",
  "groups",
  "import_rows",
  "imports",
  "memberships",
  "settlements",
  "telegram_links",
  "users",
];

afterAll(closeTestDb);

describe("migrations", () => {
  it("create every core table", async () => {
    const result = await testDb().execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(CORE_TABLES));
  });

  it("can be re-run without changing anything", async () => {
    const db = testDb();
    const count = async () =>
      (await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`))
        .rows[0]?.n;
    const before = await count();
    await runMigrations(db);
    expect(await count()).toBe(before);
  });

  it("installs the invariant triggers", async () => {
    const result = await testDb().execute<{ tgname: string }>(
      sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    expect(result.rows.map((r) => r.tgname)).toEqual([
      "audit_log_append_only",
      "expense_payers_totals_check",
      "expense_shares_totals_check",
      "expenses_no_hard_delete",
      "expenses_totals_check",
      "fx_rates_immutable",
      "settlements_no_hard_delete",
    ]);
  });
});
