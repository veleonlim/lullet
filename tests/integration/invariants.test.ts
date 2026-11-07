import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import {
  PG,
  closeTestDb,
  expectPgError,
  insertExpense,
  resetDatabase,
  seedGroup,
  testDb,
  type Seed,
} from "./helpers";

const db = testDb();
let seed: Seed;
const [A, B, C, D] = ["0", "1", "2", "3"] as const;
const who = (i: string) => seed.userIds[Number(i)] ?? "";

beforeEach(async () => {
  await resetDatabase(db);
  seed = await seedGroup(db, 4);
});
afterAll(closeTestDb);

describe("expense totals", () => {
  it("accepts several payers and an uneven split that add up exactly", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 14849,
      payers: [
        { userId: who(A), amountMinor: 10000 },
        { userId: who(B), amountMinor: 4849 },
      ],
      shares: [
        { userId: who(A), amountMinor: 4950 },
        { userId: who(B), amountMinor: 4950 },
        { userId: who(C), amountMinor: 4949 },
      ],
    });
    const rows = await db.select().from(s.expensePayers).where(eq(s.expensePayers.expenseId, id));
    expect(rows).toHaveLength(2);
  });

  it("rejects shares that do not add up to the amount, at commit", async () => {
    await expectPgError(
      insertExpense(db, {
        seed,
        amountMinor: 1000,
        payers: [{ userId: who(A), amountMinor: 1000 }],
        shares: [
          { userId: who(A), amountMinor: 500 },
          { userId: who(B), amountMinor: 499 },
        ],
      }),
      { code: PG.checkViolation, constraint: "expense_shares_total" },
    );
  });

  it("rejects payers that do not add up to the amount", async () => {
    await expectPgError(
      insertExpense(db, {
        seed,
        amountMinor: 1000,
        payers: [{ userId: who(A), amountMinor: 1001 }],
        shares: [{ userId: who(B), amountMinor: 1000 }],
      }),
      { code: PG.checkViolation, constraint: "expense_payers_total" },
    );
  });

  it("rejects an expense written without its payers and shares", async () => {
    await expectPgError(
      db.insert(s.expenses).values({
        groupId: seed.groupId,
        description: "orphan",
        spentOn: "2026-11-02",
        amountMinor: 100,
        currency: "EUR",
        createdBy: who(A),
      }),
      { code: PG.checkViolation },
    );
  });

  it("rejects changing the amount without changing the rows", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 1000,
      payers: [{ userId: who(A), amountMinor: 1000 }],
      shares: [{ userId: who(B), amountMinor: 1000 }],
    });
    await expectPgError(
      db.update(s.expenses).set({ amountMinor: 1200 }).where(eq(s.expenses.id, id)),
      {
        code: PG.checkViolation,
      },
    );
  });

  it("accepts editing the amount and the rows together in one transaction", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 1000,
      payers: [{ userId: who(A), amountMinor: 1000 }],
      shares: [{ userId: who(B), amountMinor: 1000 }],
    });
    await db.transaction(async (tx) => {
      await tx.update(s.expenses).set({ amountMinor: 1200 }).where(eq(s.expenses.id, id));
      await tx
        .update(s.expensePayers)
        .set({ amountMinor: 1200 })
        .where(eq(s.expensePayers.expenseId, id));
      await tx.delete(s.expenseShares).where(eq(s.expenseShares.expenseId, id));
      await tx.insert(s.expenseShares).values([
        { expenseId: id, groupId: seed.groupId, userId: who(B), amountMinor: 600 },
        { expenseId: id, groupId: seed.groupId, userId: who(C), amountMinor: 600 },
      ]);
    });
    const [expense] = await db.select().from(s.expenses).where(eq(s.expenses.id, id));
    expect(expense?.amountMinor).toBe(1200);
  });

  it("rejects removing a share without compensating", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 1000,
      payers: [{ userId: who(A), amountMinor: 1000 }],
      shares: [
        { userId: who(B), amountMinor: 500 },
        { userId: who(C), amountMinor: 500 },
      ],
    });
    await expectPgError(db.delete(s.expenseShares).where(eq(s.expenseShares.userId, who(C))), {
      code: PG.checkViolation,
    });
    const shares = await db.select().from(s.expenseShares).where(eq(s.expenseShares.expenseId, id));
    expect(shares).toHaveLength(2);
  });

  it("keeps the rule for soft deleted expenses too", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 1000,
      payers: [{ userId: who(A), amountMinor: 1000 }],
      shares: [{ userId: who(B), amountMinor: 1000 }],
    });
    await db
      .update(s.expenses)
      .set({ deletedAt: new Date(), deletedBy: who(A) })
      .where(eq(s.expenses.id, id));
    await expectPgError(
      db.update(s.expenseShares).set({ amountMinor: 999 }).where(eq(s.expenseShares.expenseId, id)),
      {
        code: PG.checkViolation,
      },
    );
  });

  it("allows a zero share (a percent split can round to nothing) but not a zero payer", async () => {
    await insertExpense(db, {
      seed,
      amountMinor: 1,
      payers: [{ userId: who(A), amountMinor: 1 }],
      shares: [
        { userId: who(A), amountMinor: 1 },
        { userId: who(B), amountMinor: 0 },
      ],
    });
    await expectPgError(
      insertExpense(db, {
        seed,
        amountMinor: 5,
        payers: [
          { userId: who(A), amountMinor: 5 },
          { userId: who(B), amountMinor: 0 },
        ],
        shares: [{ userId: who(A), amountMinor: 5 }],
      }),
      { code: PG.checkViolation, constraint: "expense_payers_amount_check" },
    );
  });
});

describe("expense column rules", () => {
  const base = () => ({
    seed,
    amountMinor: 1000,
    payers: [{ userId: who(A), amountMinor: 1000 }],
    shares: [{ userId: who(B), amountMinor: 1000 }],
  });

  it.each([0, -5])("rejects an amount of %i", async (amountMinor) => {
    await expectPgError(
      insertExpense(db, {
        ...base(),
        amountMinor,
        payers: [{ userId: who(A), amountMinor }],
        shares: [{ userId: who(B), amountMinor }],
      }),
      {
        code: PG.checkViolation,
        constraint: amountMinor === 0 ? "expenses_amount_check" : undefined,
      },
    );
  });

  it.each(["eur", "EU", "E1R"])("rejects the currency %s", async (currency) => {
    await expectPgError(insertExpense(db, { ...base(), currency }), {
      code: PG.checkViolation,
    });
  });

  it("only accepts a billed amount together with its currency", async () => {
    await expectPgError(
      db.insert(s.expenses).values({
        groupId: seed.groupId,
        description: "x",
        spentOn: "2026-11-02",
        amountMinor: 100,
        currency: "EUR",
        billedAmountMinor: 150,
        createdBy: who(A),
      }),
      { code: PG.checkViolation, constraint: "expenses_billed_check" },
    );
    await expectPgError(
      db.insert(s.expenses).values({
        groupId: seed.groupId,
        description: "x",
        spentOn: "2026-11-02",
        amountMinor: 100,
        currency: "EUR",
        billedCurrency: "SGD",
        createdBy: who(A),
      }),
      { code: PG.checkViolation, constraint: "expenses_billed_check" },
    );
    await expectPgError(
      insertExpense(db, { ...base(), billed: { amountMinor: 0, currency: "SGD" } }),
      {
        code: PG.checkViolation,
        constraint: "expenses_billed_check",
      },
    );
    const id = await insertExpense(db, {
      ...base(),
      billed: { amountMinor: 1500, currency: "SGD" },
    });
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, id));
    expect(row).toMatchObject({ billedAmountMinor: 1500, billedCurrency: "SGD" });
  });

  it("stores exact rates and rejects non positive ones", async () => {
    const id = await insertExpense(db, { ...base(), rate: "1.4344" });
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, id));
    expect(row?.rate).toBe("1.4344000000");
    await expectPgError(insertExpense(db, { ...base(), rate: "0" }), { code: PG.checkViolation });
  });

  it("returns dates as plain strings and amounts as numbers", async () => {
    const id = await insertExpense(db, { ...base(), spentOn: "2026-11-02" });
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, id));
    expect(row?.spentOn).toBe("2026-11-02");
    expect(row?.amountMinor).toBe(1000);
    expect(typeof row?.amountMinor).toBe("number");
  });

  it("stores integers above 2^31 without loss", async () => {
    const big = 9_007_199_254_740_000;
    const id = await insertExpense(db, {
      seed,
      amountMinor: big,
      payers: [{ userId: who(A), amountMinor: big }],
      shares: [{ userId: who(B), amountMinor: big }],
    });
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, id));
    expect(row?.amountMinor).toBe(big);
  });
});

describe("membership scoping", () => {
  it("rejects a payer who is not in the expense's group", async () => {
    const other = await seedGroup(db, 1);
    await expectPgError(
      insertExpense(db, {
        seed,
        amountMinor: 1000,
        payers: [{ userId: other.userIds[0] ?? "", amountMinor: 1000 }],
        shares: [{ userId: who(B), amountMinor: 1000 }],
      }),
      { code: PG.foreignKeyViolation, constraint: "expense_payers_membership_fk" },
    );
  });

  it("rejects a share for someone outside the group", async () => {
    const other = await seedGroup(db, 1);
    await expectPgError(
      insertExpense(db, {
        seed,
        amountMinor: 1000,
        payers: [{ userId: who(A), amountMinor: 1000 }],
        shares: [{ userId: other.userIds[0] ?? "", amountMinor: 1000 }],
      }),
      { code: PG.foreignKeyViolation, constraint: "expense_shares_membership_fk" },
    );
  });

  it("rejects rows that name a different group than their expense", async () => {
    const other = await seedGroup(db, 1);
    const id = await insertExpense(db, {
      seed,
      amountMinor: 100,
      payers: [{ userId: who(A), amountMinor: 100 }],
      shares: [{ userId: who(B), amountMinor: 100 }],
    });
    await expectPgError(
      db.insert(s.expenseShares).values({
        expenseId: id,
        groupId: other.groupId,
        userId: other.userIds[0] ?? "",
        amountMinor: 0,
      }),
      { code: PG.foreignKeyViolation, constraint: "expense_shares_expense_fk" },
    );
  });

  it("keeps member order unique within a group", async () => {
    const [extra] = await db.insert(s.users).values({ displayName: "Extra" }).returning();
    await expectPgError(
      db
        .insert(s.memberships)
        .values({ groupId: seed.groupId, userId: extra?.id ?? "", position: 0 }),
      { code: PG.uniqueViolation, constraint: "memberships_group_position_key" },
    );
    await expectPgError(
      db.insert(s.memberships).values({ groupId: seed.groupId, userId: who(A), position: 9 }),
      { code: PG.uniqueViolation, constraint: "memberships_group_user_key" },
    );
  });
});

describe("soft deletes", () => {
  it("rejects removing an expense row but allows marking it deleted", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 100,
      payers: [{ userId: who(A), amountMinor: 100 }],
      shares: [{ userId: who(B), amountMinor: 100 }],
    });
    await expectPgError(db.delete(s.expenses).where(eq(s.expenses.id, id)), {
      code: PG.restrictViolation,
    });
    await db
      .update(s.expenses)
      .set({ deletedAt: new Date(), deletedBy: who(C) })
      .where(eq(s.expenses.id, id));
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, id));
    expect(row?.deletedBy).toBe(who(C));
  });

  it("requires deleted_at and deleted_by together", async () => {
    const id = await insertExpense(db, {
      seed,
      amountMinor: 100,
      payers: [{ userId: who(A), amountMinor: 100 }],
      shares: [{ userId: who(B), amountMinor: 100 }],
    });
    await expectPgError(
      db.update(s.expenses).set({ deletedAt: new Date() }).where(eq(s.expenses.id, id)),
      {
        code: PG.checkViolation,
        constraint: "expenses_soft_delete_check",
      },
    );
    await expectPgError(
      db
        .update(s.expenses)
        .set({ deletedBy: who(A) })
        .where(eq(s.expenses.id, id)),
      {
        code: PG.checkViolation,
        constraint: "expenses_soft_delete_check",
      },
    );
  });

  it("applies the same rules to settlements", async () => {
    const [row] = await db
      .insert(s.settlements)
      .values({
        groupId: seed.groupId,
        fromUserId: who(B),
        toUserId: who(A),
        amountMinor: 2817,
        currency: "SGD",
        settledOn: "2026-11-03",
        createdBy: who(B),
      })
      .returning();
    await expectPgError(db.delete(s.settlements).where(eq(s.settlements.id, row?.id ?? "")), {
      code: PG.restrictViolation,
    });
    await db
      .update(s.settlements)
      .set({ deletedAt: new Date(), deletedBy: who(A) })
      .where(eq(s.settlements.id, row?.id ?? ""));
  });

  it("rejects settlements to oneself, of nothing, or between non members", async () => {
    const base = {
      groupId: seed.groupId,
      fromUserId: who(B),
      toUserId: who(A),
      amountMinor: 100,
      currency: "SGD",
      settledOn: "2026-11-03",
      createdBy: who(B),
    };
    await expectPgError(db.insert(s.settlements).values({ ...base, toUserId: who(B) }), {
      code: PG.checkViolation,
      constraint: "settlements_parties_check",
    });
    await expectPgError(db.insert(s.settlements).values({ ...base, amountMinor: 0 }), {
      code: PG.checkViolation,
      constraint: "settlements_amount_check",
    });
    const other = await seedGroup(db, 1);
    await expectPgError(
      db.insert(s.settlements).values({ ...base, toUserId: other.userIds[0] ?? "" }),
      {
        code: PG.foreignKeyViolation,
        constraint: "settlements_to_membership_fk",
      },
    );
  });
});

describe("audit log", () => {
  it("is append only", async () => {
    const [entry] = await db
      .insert(s.auditLog)
      .values({
        groupId: seed.groupId,
        actorUserId: who(A),
        action: "expense.delete",
        entityType: "expense",
        entityId: crypto.randomUUID(),
        before: { amountMinor: 100 },
      })
      .returning();
    expect(entry?.id).toBeGreaterThan(0);
    await expectPgError(
      db
        .update(s.auditLog)
        .set({ action: "tampered" })
        .where(eq(s.auditLog.id, entry?.id ?? 0)),
      { code: PG.restrictViolation },
    );
    await expectPgError(db.delete(s.auditLog).where(eq(s.auditLog.id, entry?.id ?? 0)), {
      code: PG.restrictViolation,
    });
  });

  it("stores structured before and after values", async () => {
    await db.insert(s.auditLog).values({
      groupId: seed.groupId,
      action: "expense.update",
      entityType: "expense",
      before: { amountMinor: 100, payers: [{ userId: who(A), amountMinor: 100 }] },
      after: { amountMinor: 120 },
    });
    const [row] = await db.select().from(s.auditLog);
    expect(row?.actorUserId).toBeNull();
    expect(row?.before).toEqual({
      amountMinor: 100,
      payers: [{ userId: who(A), amountMinor: 100 }],
    });
  });
});

describe("exchange rates", () => {
  const rate = {
    rateDate: "2026-11-07",
    base: "EUR",
    quote: "SGD",
    rate: "1.4309",
    sourceDate: "2026-11-06",
  };

  it("stores a market rate once and never changes it", async () => {
    await db.insert(s.fxRates).values(rate);
    await expectPgError(db.update(s.fxRates).set({ rate: "9.9" }), { code: PG.restrictViolation });
    await db
      .insert(s.fxRates)
      .values({ ...rate, rate: "1.5" })
      .onConflictDoNothing();
    const rows = await db.select().from(s.fxRates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rate).toBe("1.4309000000");
    expect(rows[0]?.sourceDate).toBe("2026-11-06");
    await expectPgError(db.insert(s.fxRates).values({ ...rate, rate: "1.5" }), {
      code: PG.uniqueViolation,
    });
  });

  it.each([
    ["a rate of zero", { rate: "0" }],
    ["the same currency twice", { quote: "EUR" }],
    ["a lower case code", { base: "eur" }],
    ["a source date after the rate date", { sourceDate: "2026-11-08" }],
  ])("rejects %s", async (_label, patch) => {
    await expectPgError(db.insert(s.fxRates).values({ ...rate, ...patch }), {
      code: PG.checkViolation,
    });
  });

  it("lets a group set and change a default rate for a day", async () => {
    const row = {
      groupId: seed.groupId,
      rateDate: "2026-11-02",
      base: "EUR",
      rate: "1.51",
      setBy: who(A),
    };
    await db.insert(s.dailyRates).values(row);
    await expectPgError(db.insert(s.dailyRates).values(row), { code: PG.uniqueViolation });
    await db
      .update(s.dailyRates)
      .set({ rate: "1.52" })
      .where(eq(s.dailyRates.groupId, seed.groupId));
    const [stored] = await db.select().from(s.dailyRates);
    expect(stored).toMatchObject({ quote: "SGD", rate: "1.5200000000" });
    await expectPgError(
      db.insert(s.dailyRates).values({ ...row, rateDate: "2026-11-03", rate: "-1" }),
      {
        code: PG.checkViolation,
      },
    );
  });
});

describe("budgets", () => {
  it("allows one default and one override per day, nothing twice", async () => {
    const row = { groupId: seed.groupId, amountMinor: 20000, setBy: who(A) };
    await db.insert(s.budgets).values({ ...row, day: null });
    await expectPgError(db.insert(s.budgets).values({ ...row, day: null }), {
      code: PG.uniqueViolation,
      constraint: "budgets_group_day_key",
    });
    await db.insert(s.budgets).values({ ...row, day: "2026-11-02", amountMinor: 35000 });
    await expectPgError(db.insert(s.budgets).values({ ...row, day: "2026-11-02" }), {
      code: PG.uniqueViolation,
    });
    await expectPgError(
      db.insert(s.budgets).values({ ...row, day: "2026-11-03", amountMinor: -1 }),
      {
        code: PG.checkViolation,
      },
    );
  });
});

describe("imports", () => {
  const hash = "a".repeat(64);
  const draft = () => ({
    groupId: seed.groupId,
    uploaderId: who(A),
    source: "telegram" as const,
    imageSha256: hash,
  });

  it("rejects the same image twice while it is a draft or confirmed", async () => {
    await db.insert(s.imports).values(draft());
    await expectPgError(db.insert(s.imports).values(draft()), {
      code: PG.uniqueViolation,
      constraint: "imports_group_image_active_key",
    });
  });

  it("allows uploading the image again after the first import was cancelled", async () => {
    await db.insert(s.imports).values({ ...draft(), status: "cancelled" });
    await db.insert(s.imports).values(draft());
    expect(await db.select().from(s.imports)).toHaveLength(2);
  });

  it("only lets group members upload", async () => {
    const other = await seedGroup(db, 1);
    await expectPgError(
      db.insert(s.imports).values({ ...draft(), uploaderId: other.userIds[0] ?? "" }),
      {
        code: PG.foreignKeyViolation,
        constraint: "imports_uploader_membership_fk",
      },
    );
  });

  it("checks the image hash and the status timestamps", async () => {
    await expectPgError(db.insert(s.imports).values({ ...draft(), imageSha256: "A".repeat(64) }), {
      code: PG.checkViolation,
      constraint: "imports_sha256_check",
    });
    await expectPgError(db.insert(s.imports).values({ ...draft(), status: "confirmed" }), {
      code: PG.checkViolation,
      constraint: "imports_confirmed_check",
    });
    await expectPgError(
      db.insert(s.imports).values({ ...draft(), status: "undone", confirmedAt: new Date() }),
      { code: PG.checkViolation, constraint: "imports_undone_check" },
    );
    await db
      .insert(s.imports)
      .values({ ...draft(), status: "undone", confirmedAt: new Date(), undoneAt: new Date() });
  });

  it("keeps rows in a fixed order and deletes them with their import", async () => {
    const [imp] = await db.insert(s.imports).values(draft()).returning();
    const importId = imp?.id ?? "";
    await db.insert(s.importRows).values([
      {
        importId,
        position: 0,
        merchant: "Trattoria",
        amountMinor: 4850,
        currency: "EUR",
        category: "food",
      },
      {
        importId,
        position: 1,
        merchant: "Metro",
        amountMinor: 1200,
        currency: "EUR",
        category: "transport",
      },
    ]);
    await expectPgError(db.insert(s.importRows).values({ importId, position: 1 }), {
      code: PG.uniqueViolation,
    });
    await expectPgError(db.insert(s.importRows).values({ importId, position: 2, amountMinor: 0 }), {
      code: PG.checkViolation,
    });
    await expectPgError(
      db.insert(s.importRows).values({ importId, position: 2, categoryConfidence: 101 }),
      {
        code: PG.checkViolation,
      },
    );
    const [row] = await db.select().from(s.importRows).where(eq(s.importRows.position, 0));
    expect(row?.issues).toEqual([]);
    expect(row?.included).toBe(true);

    await db.delete(s.imports).where(eq(s.imports.id, importId));
    expect(await db.select().from(s.importRows)).toHaveLength(0);
  });

  it("links a confirmed expense to the import row it came from, once", async () => {
    const [imp] = await db.insert(s.imports).values(draft()).returning();
    const [row] = await db
      .insert(s.importRows)
      .values({ importId: imp?.id ?? "", position: 0, amountMinor: 1000, currency: "EUR" })
      .returning();
    const base = {
      seed,
      amountMinor: 1000,
      payers: [{ userId: who(A), amountMinor: 1000 }],
      shares: [{ userId: who(B), amountMinor: 1000 }],
    };
    const id = await insertExpense(db, base);
    await db
      .update(s.expenses)
      .set({ importId: imp?.id, importRowId: row?.id })
      .where(eq(s.expenses.id, id));
    const second = await insertExpense(db, base);
    await expectPgError(
      db.update(s.expenses).set({ importRowId: row?.id }).where(eq(s.expenses.id, second)),
      { code: PG.uniqueViolation },
    );
  });
});

describe("telegram links", () => {
  it("links one Telegram account to one user, and vice versa", async () => {
    await db.insert(s.telegramLinks).values({ userId: who(A), telegramUserId: 111, username: "a" });
    await expectPgError(
      db.insert(s.telegramLinks).values({ userId: who(B), telegramUserId: 111 }),
      {
        code: PG.uniqueViolation,
      },
    );
    await expectPgError(
      db.insert(s.telegramLinks).values({ userId: who(A), telegramUserId: 222 }),
      {
        code: PG.uniqueViolation,
      },
    );
    await expectPgError(db.insert(s.telegramLinks).values({ userId: who(C), telegramUserId: -5 }), {
      code: PG.checkViolation,
    });
  });
});

describe("database sanity", () => {
  it("runs in a clean state for every test", async () => {
    const result = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM expenses`);
    expect(result.rows[0]?.n).toBe("0");
    expect(D).toBe("3");
  });
});
