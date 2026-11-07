import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { expenseSnapshotSchema, summariseLedger, type ExpenseInput } from "@/lib/ledger";
import {
  ConflictError,
  createLedgerStore,
  InvalidReferenceError,
  NotAMemberError,
  NotFoundError,
  RateUnavailableError,
} from "@/server/ledger";
import { closeTestDb, resetDatabase, seedGroup, testDb } from "./helpers";
import { expenseInput, FakeFx, settlementInput, storeFor } from "./ledger-support";

const db = testDb();

beforeEach(() => resetDatabase(db));
afterAll(closeTestDb);

describe("expenses", () => {
  it("creates an expense with payers, shares and an audit entry", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    const created = await store.createExpense(expenseInput(seed));

    expect(created.description).toBe("Trattoria");
    expect(created.amountMinor).toBe(14849);
    expect(created.payers).toEqual([{ userId: seed.userIds[0], amountMinor: 14849 }]);
    expect(created.shares.map((x) => x.amountMinor)).toEqual([3713, 3712, 3712, 3712]);
    expect(created.createdBy).toBe(seed.userIds[0]);
    expect(created.deletedAt).toBeNull();

    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, created.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      groupId: seed.groupId,
      actorUserId: seed.userIds[0],
      action: "expense.create",
      entityType: "expense",
      before: null,
    });
    expect(expenseSnapshotSchema.parse(audit[0]?.after).amountMinor).toBe(14849);
  });

  it("stores several payers, uneven splits and the per-expense rate", async () => {
    const seed = await seedGroup(db);
    const [a, b, c] = seed.userIds as [string, string, string, string];
    const store = storeFor(db, seed);
    const created = await store.createExpense(
      expenseInput(seed, {
        amount: "90.00",
        currency: "CHF",
        rate: { rate: "1.62", currency: "CHF" },
        payers: seed.userIds.map((userId, i) => ({
          userId,
          included: i < 2,
          amount: i === 0 ? "60.00" : "30.00",
        })),
        split: {
          mode: "shares",
          members: seed.userIds.map((userId, i) => ({
            userId,
            included: i < 3,
            value: i === 0 ? "2" : "1",
          })),
        },
      }),
    );
    expect(created.payers.map((p) => [p.userId, p.amountMinor])).toEqual([
      [a, 6000],
      [b, 3000],
    ]);
    expect(created.shares.map((p) => [p.userId, p.amountMinor, p.weight])).toEqual([
      [a, 4500, 2],
      [b, 2250, 1],
      [c, 2250, 1],
    ]);
    expect(created.splitMethod).toBe("shares");
    expect(created.rate).toBe("1.6200000000");
    expect(created.rateCurrency).toBe("CHF");
  });

  it("lists newest first and loads the whole ledger for pricing", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    await store.createExpense(expenseInput(seed, { description: "Early", spentOn: "2026-11-01" }));
    await store.createExpense(expenseInput(seed, { description: "Late", spentOn: "2026-11-03" }));
    await store.createExpense(expenseInput(seed, { description: "Later", spentOn: "2026-11-03" }));

    expect((await store.listExpenses()).map((e) => e.description)).toEqual([
      "Later",
      "Late",
      "Early",
    ]);
    const ledger = await store.loadLedger();
    expect(ledger.members).toHaveLength(4);
    const summary = summariseLedger({
      memberOrder: ledger.members.map((m) => m.userId),
      expenses: ledger.expenses,
      settlements: ledger.settlements,
      book: ledger.book,
    });
    expect(summary.unpricedExpenseIds).toEqual([]);
    expect(summary.totalSpendMinor).toBe(3 * 22274);
  });

  describe("exchange rates", () => {
    it("fetches a day's market rate once, stores it, and reuses it", async () => {
      const seed = await seedGroup(db);
      const fx = new FakeFx({ EUR: "1.5" });
      const store = storeFor(db, seed, { fx });
      await store.createExpense(expenseInput(seed));
      await store.createExpense(expenseInput(seed, { description: "Same day" }));
      expect(fx.calls).toEqual(["2026-11-02|EUR|SGD"]);

      const [stored] = await db.select().from(s.fxRates);
      expect(stored).toMatchObject({ rateDate: "2026-11-02", base: "EUR", quote: "SGD" });
      expect(Number(stored?.rate)).toBe(1.5);

      await store.createExpense(expenseInput(seed, { spentOn: "2026-11-03" }));
      expect(fx.calls).toHaveLength(2);
    });

    it("needs no market rate for SGD, a billed SGD figure, or the expense's own rate", async () => {
      const seed = await seedGroup(db);
      const fx = new FakeFx({});
      const store = storeFor(db, seed, { fx });
      await store.createExpense(expenseInput(seed, { currency: "SGD" }));
      await store.createExpense(
        expenseInput(seed, { billed: { amount: "230.00", currency: "SGD" } }),
      );
      await store.createExpense(expenseInput(seed, { rate: { rate: "1.51", currency: "EUR" } }));
      expect(fx.calls).toEqual([]);
    });

    it("converts the billed amount when the bank billed another currency", async () => {
      const seed = await seedGroup(db);
      const fx = new FakeFx({ CHF: "1.6" });
      const store = storeFor(db, seed, { fx });
      await store.createExpense(
        expenseInput(seed, { currency: "EUR", billed: { amount: "100.00", currency: "CHF" } }),
      );
      expect(fx.calls).toEqual(["2026-11-02|CHF|SGD"]);
    });

    it("uses the group's day override instead of fetching", async () => {
      const seed = await seedGroup(db);
      await db.insert(s.dailyRates).values({
        groupId: seed.groupId,
        rateDate: "2026-11-02",
        base: "EUR",
        rate: "1.55",
        setBy: seed.userIds[0] ?? "",
      });
      const fx = new FakeFx({});
      await storeFor(db, seed, { fx }).createExpense(expenseInput(seed));
      expect(fx.calls).toEqual([]);
    });

    it("refuses the expense when no rate can be fetched, and stores nothing", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed, { fx: new FakeFx({}) });
      await expect(store.createExpense(expenseInput(seed))).rejects.toBeInstanceOf(
        RateUnavailableError,
      );
      expect(await db.select().from(s.expenses)).toHaveLength(0);
      expect(await db.select().from(s.auditLog)).toHaveLength(0);
    });

    it("lets a group price its own expenses from the stored rate even if the source is down", async () => {
      const seed = await seedGroup(db);
      await storeFor(db, seed).createExpense(expenseInput(seed));
      const offline = storeFor(db, seed, { fx: new FakeFx({}), as: 1 });
      await expect(offline.createExpense(expenseInput(seed, {}, 1))).resolves.toBeDefined();
    });

    it("rethrows unexpected rate source failures", async () => {
      const seed = await seedGroup(db);
      const broken = {
        getRate: () => Promise.reject(new Error("boom")),
      };
      await expect(
        storeFor(db, seed, { fx: broken }).createExpense(expenseInput(seed)),
      ).rejects.toThrow("boom");
    });
  });

  describe("editing", () => {
    it("replaces the record, payers and shares and audits before and after", async () => {
      const seed = await seedGroup(db);
      const creator = storeFor(db, seed);
      const editor = storeFor(db, seed, { as: 2 });
      const created = await creator.createExpense(expenseInput(seed));

      const updated = await editor.updateExpense(
        created.id,
        expenseInput(seed, {
          description: "Trattoria Roma",
          amount: "100.00",
          split: {
            mode: "equal",
            members: seed.userIds.map((userId, i) => ({ userId, included: i < 2, value: "" })),
          },
        }),
        created.updatedAt,
      );
      expect(updated.description).toBe("Trattoria Roma");
      expect(updated.payers).toEqual([{ userId: seed.userIds[0], amountMinor: 10000 }]);
      expect(updated.shares.map((x) => x.amountMinor)).toEqual([5000, 5000]);
      expect(updated.createdBy).toBe(seed.userIds[0]);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

      const history = await editor.expenseHistory(created.id);
      expect(history.map((h) => [h.action, h.actorUserId])).toEqual([
        ["expense.create", seed.userIds[0]],
        ["expense.update", seed.userIds[2]],
      ]);
      const last = history[1];
      expect(expenseSnapshotSchema.parse(last?.before).amountMinor).toBe(14849);
      expect(expenseSnapshotSchema.parse(last?.after).amountMinor).toBe(10000);
    });

    it("refuses an edit based on an out of date copy", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed);
      const created = await store.createExpense(expenseInput(seed));
      await store.updateExpense(
        created.id,
        expenseInput(seed, { amount: "10.00" }),
        created.updatedAt,
      );
      await expect(
        store.updateExpense(created.id, expenseInput(seed, { amount: "20.00" }), created.updatedAt),
      ).rejects.toBeInstanceOf(ConflictError);
      expect((await store.getExpense(created.id))?.amountMinor).toBe(1000);
    });

    it("refuses to edit a deleted expense until it is restored", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed);
      const created = await store.createExpense(expenseInput(seed));
      const deleted = await store.deleteExpense(created.id);
      await expect(
        store.updateExpense(created.id, expenseInput(seed), deleted.updatedAt),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("keeps the old figures when the new ones are refused", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed, { fx: new FakeFx({ EUR: "1.5" }) });
      const created = await store.createExpense(expenseInput(seed));
      await expect(
        store.updateExpense(
          created.id,
          expenseInput(seed, { currency: "CHF", spentOn: "2026-11-09" }),
          created.updatedAt,
        ),
      ).rejects.toBeInstanceOf(RateUnavailableError);
      expect((await store.getExpense(created.id))?.currency).toBe("EUR");
    });
  });

  describe("soft delete and restore", () => {
    it("hides a deleted expense from the ledger, keeps it, and brings it back", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed, { as: 1 });
      const created = await store.createExpense(expenseInput(seed, {}, 1));

      const deleted = await store.deleteExpense(created.id);
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect(deleted.deletedBy).toBe(seed.userIds[1]);
      expect(await store.listExpenses()).toHaveLength(0);
      expect((await store.listExpenses({ deleted: true })).map((e) => e.id)).toEqual([created.id]);
      expect((await store.loadLedger()).expenses).toHaveLength(0);
      expect((await store.getExpense(created.id))?.deletedAt).not.toBeNull();
      // The row is still in the table, with its payers and shares.
      expect(await db.select().from(s.expenseShares)).toHaveLength(4);

      const restored = await store.restoreExpense(created.id);
      expect(restored.deletedAt).toBeNull();
      expect(restored.deletedBy).toBeNull();
      expect(await store.listExpenses()).toHaveLength(1);

      const actions = (await store.expenseHistory(created.id)).map((h) => h.action);
      expect(actions).toEqual(["expense.create", "expense.delete", "expense.restore"]);
    });

    it("does nothing, and logs nothing, when already in the requested state", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed);
      const created = await store.createExpense(expenseInput(seed));
      await store.restoreExpense(created.id);
      await store.deleteExpense(created.id);
      await store.deleteExpense(created.id);
      expect((await store.expenseHistory(created.id)).map((h) => h.action)).toEqual([
        "expense.create",
        "expense.delete",
      ]);
    });

    it("reports a missing expense", async () => {
      const seed = await seedGroup(db);
      const store = storeFor(db, seed);
      const missing = "00000000-0000-4000-8000-000000000000";
      await expect(store.deleteExpense(missing)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.restoreExpense(missing)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.expenseHistory(missing)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        store.updateExpense(missing, expenseInput(seed), new Date()),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await store.getExpense(missing)).toBeNull();
      // Ids come from URLs: junk is "not found", never a database error.
      expect(await store.getExpense("not-a-uuid")).toBeNull();
      await expect(store.deleteExpense("not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.expenseHistory("not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.deleteSettlement("not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        store.updateExpense("not-a-uuid", expenseInput(seed), new Date()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("rejects payers and sharers from outside the group", async () => {
    const seed = await seedGroup(db);
    const other = await seedGroup(db);
    const store = storeFor(db, seed);
    const input: ExpenseInput = {
      ...expenseInput(seed),
      payers: [{ userId: other.userIds[0] ?? "", amountMinor: 14849 }],
    };
    await expect(store.createExpense(input)).rejects.toBeInstanceOf(InvalidReferenceError);
    expect(await db.select().from(s.expenses)).toHaveLength(0);
  });
});

describe("history", () => {
  it("lists the audit trail oldest first with before and after", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    const created = await store.createExpense(expenseInput(seed));
    await store.updateExpense(
      created.id,
      expenseInput(seed, { amount: "10.00" }),
      created.updatedAt,
    );
    const history = await store.expenseHistory(created.id);
    expect(history.map((h) => h.id)).toEqual([...history.map((h) => h.id)].sort((x, y) => x - y));
    expect(history[0]?.before).toBeNull();
    expect(history[0]?.createdAt).toBeInstanceOf(Date);
  });
});

describe("settlements", () => {
  it("records, lists, deletes and restores a settlement with audit entries", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed, { as: 1 });
    const created = await store.createSettlement(settlementInput(seed, { note: "cash" }));
    expect(created).toMatchObject({
      fromUserId: seed.userIds[1],
      toUserId: seed.userIds[0],
      amountMinor: 5000,
      currency: "SGD",
      note: "cash",
      createdBy: seed.userIds[1],
    });
    expect((await store.listSettlements()).map((x) => x.id)).toEqual([created.id]);
    expect((await store.loadLedger()).settlements).toHaveLength(1);

    const deleted = await store.deleteSettlement(created.id);
    expect(deleted.deletedBy).toBe(seed.userIds[1]);
    expect(await store.listSettlements()).toHaveLength(0);
    expect((await store.listSettlements({ deleted: true })).map((x) => x.id)).toEqual([created.id]);
    await store.deleteSettlement(created.id);

    const restored = await store.restoreSettlement(created.id);
    expect(restored.deletedAt).toBeNull();
    await store.restoreSettlement(created.id);

    const audit = await db
      .select({ action: s.auditLog.action })
      .from(s.auditLog)
      .where(eq(s.auditLog.entityId, created.id))
      .orderBy(asc(s.auditLog.id));
    expect(audit.map((a) => a.action)).toEqual([
      "settlement.create",
      "settlement.delete",
      "settlement.restore",
    ]);
  });

  it("handles currency and rate like an expense", async () => {
    const seed = await seedGroup(db);
    const fx = new FakeFx({ EUR: "1.5" });
    const store = storeFor(db, seed, { fx });
    await store.createSettlement(settlementInput(seed, { currency: "EUR", amount: "30.00" }));
    expect(fx.calls).toEqual(["2026-11-05|EUR|SGD"]);
    await store.createSettlement(
      settlementInput(seed, {
        currency: "EUR",
        amount: "30.00",
        rate: { rate: "1.6", currency: "EUR" },
      }),
    );
    await store.createSettlement(
      settlementInput(seed, {
        currency: "EUR",
        amount: "30.00",
        billed: { amount: "47", currency: "SGD" },
      }),
    );
    expect(fx.calls).toHaveLength(1);
    await expect(
      storeFor(db, seed, { fx: new FakeFx({}) }).createSettlement(
        settlementInput(seed, { currency: "CHF", amount: "10" }),
      ),
    ).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it("changes the balances and the suggested payments", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    await store.createExpense(expenseInput(seed, { currency: "SGD", amount: "100.00" }));
    const net = async () => {
      const ledger = await store.loadLedger();
      return summariseLedger({
        memberOrder: ledger.members.map((m) => m.userId),
        expenses: ledger.expenses,
        settlements: ledger.settlements,
        book: ledger.book,
      });
    };
    expect((await net()).transfers.map((t) => t.minor)).toEqual([2500, 2500, 2500]);
    await store.createSettlement(settlementInput(seed, { amount: "25.00" }, 1, 0));
    const after = await net();
    expect(after.transfers.map((t) => t.minor)).toEqual([2500, 2500]);
    expect(after.balances.reporting.map((m) => m.balanceMinor)).toEqual([5000, 0, -2500, -2500]);
  });

  it("rejects parties from outside the group and missing settlements", async () => {
    const seed = await seedGroup(db);
    const other = await seedGroup(db);
    const store = storeFor(db, seed);
    await expect(
      store.createSettlement({ ...settlementInput(seed), toUserId: other.userIds[0] ?? "" }),
    ).rejects.toBeInstanceOf(InvalidReferenceError);
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(store.deleteSettlement(missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.restoreSettlement(missing)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("membership", () => {
  it("refuses a session whose user is not in the group, for every method", async () => {
    const seed = await seedGroup(db);
    const outsider = await seedGroup(db);
    const store = createLedgerStore({
      db,
      session: { userId: outsider.userIds[0] ?? "", groupId: seed.groupId },
      fx: new FakeFx({}),
    });
    const id = "00000000-0000-4000-8000-000000000000";
    const calls = [
      () => store.members(),
      () => store.loadLedger(),
      () => store.listExpenses(),
      () => store.getExpense(id),
      () => store.createExpense(expenseInput(seed)),
      () => store.updateExpense(id, expenseInput(seed), new Date()),
      () => store.deleteExpense(id),
      () => store.restoreExpense(id),
      () => store.expenseHistory(id),
      () => store.listSettlements(),
      () => store.createSettlement(settlementInput(seed)),
      () => store.deleteSettlement(id),
      () => store.restoreSettlement(id),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(NotAMemberError);
    expect(await db.select().from(s.expenses)).toHaveLength(0);
    expect(await db.select().from(s.auditLog)).toHaveLength(0);
  });
});
