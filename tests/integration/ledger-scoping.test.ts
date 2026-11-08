import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import type { StoredExpense, StoredSettlement } from "@/lib/ledger";
import { parseRate } from "@/lib/money";
import { InvalidReferenceError, NotFoundError, type LedgerStore } from "@/server/ledger";
import { closeTestDb, resetDatabase, testDb, type Seed } from "./helpers";
import { expenseInput, seedTwoGroups, settlementInput, storeFor } from "./ledger-support";

/**
 * Proof that every query of the data layer is scoped to the caller's group. Group A
 * and group B each hold an active and a deleted expense and settlement. A store for a
 * member of A is driven through EVERY public method with B's ids and B's people; none
 * may read, change or even confirm the existence of anything in B.
 *
 * `probes` is typed as a record over every method of the store, so adding a method to
 * the data layer without adding its probe here fails the type check.
 */

const db = testDb();

beforeEach(() => resetDatabase(db));
afterAll(closeTestDb);

type ScopedMethod = Exclude<keyof LedgerStore, "session">;

interface World {
  readonly store: LedgerStore;
  readonly a: {
    readonly seed: Seed;
    readonly userIds: readonly string[];
    readonly expense: StoredExpense;
    readonly deletedExpense: StoredExpense;
    readonly settlement: StoredSettlement;
  };
  readonly b: {
    readonly seed: Seed;
    readonly userIds: readonly string[];
    readonly groupId: string;
    readonly importId: string;
    readonly expense: StoredExpense;
    readonly deletedExpense: StoredExpense;
    readonly settlement: StoredSettlement;
    readonly deletedSettlement: StoredSettlement;
  };
}

async function buildWorld(): Promise<World> {
  const { a, b } = await seedTwoGroups(db);
  const storeA = storeFor(db, a);
  const storeB = storeFor(db, b);

  const aExpense = await storeA.createExpense(expenseInput(a, { description: "A active" }));
  const aDeleted = await storeA.createExpense(expenseInput(a, { description: "A deleted" }));
  await storeA.deleteExpense(aDeleted.id);
  const aSettlement = await storeA.createSettlement(settlementInput(a));

  const bExpense = await storeB.createExpense(expenseInput(b, { description: "B active" }));
  const bDeleted = await storeB.createExpense(expenseInput(b, { description: "B deleted" }));
  const bDeletedExpense = await storeB.deleteExpense(bDeleted.id);
  const [bImport] = await db
    .insert(s.imports)
    .values({
      groupId: b.groupId,
      uploaderId: b.userIds[0] ?? "",
      source: "web",
      imageSha256: "a".repeat(64),
      status: "draft",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: s.imports.id });
  await db
    .update(s.expenses)
    .set({ importId: bImport?.id ?? "" })
    .where(eq(s.expenses.id, bExpense.id));
  const bSettlement = await storeB.createSettlement(settlementInput(b));
  const bDeletedSettlement = await storeB.deleteSettlement(
    (await storeB.createSettlement(settlementInput(b, { amount: "7.00" }))).id,
  );
  // Group B also has a budget, a day budget, a day rate and trip dates of its own.
  await storeB.setBudget({ day: null, amountMinor: 10_000 });
  await storeB.setBudget({ day: "2026-11-02", amountMinor: 5_000 });
  await storeB.updateTrip({
    tripStart: "2026-11-01",
    tripEnd: "2026-11-09",
    timeZone: "Asia/Tokyo",
  });
  await storeB.setDailyRate({ day: "2026-11-02", currency: "EUR", rate: parseRate("9.9") });

  return {
    store: storeA,
    a: {
      seed: a,
      userIds: a.userIds,
      expense: aExpense,
      deletedExpense: aDeleted,
      settlement: aSettlement,
    },
    b: {
      seed: b,
      userIds: b.userIds,
      groupId: b.groupId,
      importId: bImport?.id ?? "",
      expense: bExpense,
      deletedExpense: bDeletedExpense,
      settlement: bSettlement,
      deletedSettlement: bDeletedSettlement,
    },
  };
}

/** Everything stored for group B, to prove a probe changed none of it. */
async function snapshotOfB(groupId: string) {
  const [expenses, payers, shares, settlements, audit, budgets, dayRates, groups] =
    await Promise.all([
      db.select().from(s.expenses).where(eq(s.expenses.groupId, groupId)),
      db.select().from(s.expensePayers).where(eq(s.expensePayers.groupId, groupId)),
      db.select().from(s.expenseShares).where(eq(s.expenseShares.groupId, groupId)),
      db.select().from(s.settlements).where(eq(s.settlements.groupId, groupId)),
      db.select().from(s.auditLog).where(eq(s.auditLog.groupId, groupId)),
      db.select().from(s.budgets).where(eq(s.budgets.groupId, groupId)),
      db.select().from(s.dailyRates).where(eq(s.dailyRates.groupId, groupId)),
      db.select().from(s.groups).where(eq(s.groups.id, groupId)),
    ]);
  return { expenses, payers, shares, settlements, audit, budgets, dayRates, groups };
}

const probes: Record<ScopedMethod, (world: World) => Promise<void>> = {
  members: async ({ store, a, b }) => {
    const ids = (await store.members()).map((m) => m.userId);
    expect(ids).toEqual([...a.userIds]);
    expect(ids.some((id) => b.userIds.includes(id))).toBe(false);
  },

  loadLedger: async ({ store, a, b }) => {
    const ledger = await store.loadLedger();
    expect(ledger.expenses.map((e) => e.id)).toEqual([a.expense.id]);
    expect(ledger.settlements.map((x) => x.id)).toEqual([a.settlement.id]);
    const everything = JSON.stringify(ledger.expenses) + JSON.stringify(ledger.settlements);
    for (const id of b.userIds) expect(everything).not.toContain(id);
  },

  rateBookFor: async ({ store }) => {
    // Group B has its own day rate (see buildWorld); group A must not see it, only the shared market rate.
    await db
      .insert(s.fxRates)
      .values({
        rateDate: "2026-11-02",
        base: "EUR",
        quote: "SGD",
        rate: "1.5",
        sourceDate: "2026-11-02",
      })
      .onConflictDoNothing();
    const book = await store.rateBookFor([
      { spentOn: "2026-11-02", currency: "EUR", billedCurrency: null },
    ]);
    expect(book.dayOverride("2026-11-02", "EUR")).toBeUndefined();
    expect(book.market("2026-11-02", "EUR")).toBeDefined();
  },

  listExpenses: async ({ store, a, b }) => {
    expect((await store.listExpenses()).map((e) => e.id)).toEqual([a.expense.id]);
    expect((await store.listExpenses({ deleted: true })).map((e) => e.id)).toEqual([
      a.deletedExpense.id,
    ]);
    const all = [...(await store.listExpenses()), ...(await store.listExpenses({ deleted: true }))];
    expect(all.map((e) => e.id)).not.toContain(b.expense.id);
    expect(all.map((e) => e.id)).not.toContain(b.deletedExpense.id);
  },

  getExpense: async ({ store, a, b }) => {
    expect(await store.getExpense(b.expense.id)).toBeNull();
    expect(await store.getExpense(b.deletedExpense.id)).toBeNull();
    expect((await store.getExpense(a.expense.id))?.id).toBe(a.expense.id);
  },

  listImportExpenses: async ({ store, b }) => {
    // Group B's expense came from one of group B's screenshot imports; A cannot list it.
    expect(await store.listImportExpenses(b.importId)).toEqual([]);
    expect(await store.listImportExpenses("not-a-uuid")).toEqual([]);
  },

  createExpense: async ({ store, a, b }) => {
    // Group B's people cannot pay for or share an expense of group A...
    await expect(store.createExpense(expenseInput(b.seed, {}, 0))).rejects.toBeInstanceOf(
      InvalidReferenceError,
    );
    // ...even when mixed in with A's own people.
    const mixed = expenseInput(a.seed);
    await expect(
      store.createExpense({
        ...mixed,
        shares: [
          { userId: a.userIds[0] ?? "", amountMinor: mixed.amountMinor - 1, weight: null },
          { userId: b.userIds[0] ?? "", amountMinor: 1, weight: null },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidReferenceError);
    // What a valid call creates lands in the caller's group only.
    const created = await store.createExpense(mixed);
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, created.id));
    expect(row?.groupId).not.toBe(b.groupId);
    expect((await store.listExpenses()).map((e) => e.id)).toContain(created.id);
  },

  updateExpense: async ({ store, a, b }) => {
    const input = expenseInput(a.seed, { description: "hijacked" });
    await expect(
      store.updateExpense(b.expense.id, input, b.expense.updatedAt),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      store.updateExpense(b.deletedExpense.id, input, b.deletedExpense.updatedAt),
    ).rejects.toBeInstanceOf(NotFoundError);
  },

  deleteExpense: async ({ store, b }) => {
    await expect(store.deleteExpense(b.expense.id)).rejects.toBeInstanceOf(NotFoundError);
  },

  restoreExpense: async ({ store, b }) => {
    await expect(store.restoreExpense(b.deletedExpense.id)).rejects.toBeInstanceOf(NotFoundError);
  },

  expenseHistory: async ({ store, a, b }) => {
    await expect(store.expenseHistory(b.expense.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.expenseHistory(b.deletedExpense.id)).rejects.toBeInstanceOf(NotFoundError);
    const history = await store.expenseHistory(a.expense.id);
    expect(history.length).toBeGreaterThan(0);
    for (const entry of history) {
      expect(entry.actorUserId).not.toBeNull();
      expect(b.userIds).not.toContain(entry.actorUserId);
    }
  },

  listSettlements: async ({ store, a, b }) => {
    expect((await store.listSettlements()).map((x) => x.id)).toEqual([a.settlement.id]);
    expect(await store.listSettlements({ deleted: true })).toEqual([]);
    const everything = JSON.stringify([
      ...(await store.listSettlements()),
      ...(await store.listSettlements({ deleted: true })),
    ]);
    expect(everything).not.toContain(b.settlement.id);
    expect(everything).not.toContain(b.deletedSettlement.id);
  },

  createSettlement: async ({ store, a, b }) => {
    const own = settlementInput(a.seed);
    await expect(
      store.createSettlement({ ...own, toUserId: b.userIds[0] ?? "" }),
    ).rejects.toBeInstanceOf(InvalidReferenceError);
    await expect(
      store.createSettlement({ ...own, fromUserId: b.userIds[1] ?? "" }),
    ).rejects.toBeInstanceOf(InvalidReferenceError);
    const created = await store.createSettlement(own);
    const [row] = await db.select().from(s.settlements).where(eq(s.settlements.id, created.id));
    expect(row?.groupId).not.toBe(b.groupId);
  },

  deleteSettlement: async ({ store, b }) => {
    await expect(store.deleteSettlement(b.settlement.id)).rejects.toBeInstanceOf(NotFoundError);
  },

  restoreSettlement: async ({ store, b }) => {
    await expect(store.restoreSettlement(b.deletedSettlement.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  },

  loadDashboard: async ({ store, a, b }) => {
    const data = await store.loadDashboard();
    expect(data.expenses.map((e) => e.id)).toEqual([a.expense.id]);
    expect(data.members.map((m) => m.userId)).toEqual([...a.userIds]);
    // B's budgets, trip dates and day rate are invisible to A.
    expect(data.budgets.defaultMinor).toBeNull();
    expect(data.budgets.overrides.size).toBe(0);
    expect(data.tripStart).toBeNull();
    expect(data.timeZone).toBe("Europe/Zurich");
    expect(data.book.dayOverride("2026-11-02", "EUR")).toBeUndefined();
    expect(JSON.stringify(data.expenses)).not.toContain(b.userIds[0] ?? "-");
  },

  updateTrip: async ({ store }) => {
    const updated = await store.updateTrip({
      tripStart: "2026-11-03",
      tripEnd: "2026-11-12",
      timeZone: "Europe/Rome",
    });
    expect(updated).toEqual({
      tripStart: "2026-11-03",
      tripEnd: "2026-11-12",
      timeZone: "Europe/Rome",
    });
    expect((await store.loadDashboard()).tripEnd).toBe("2026-11-12");
  },

  setBudget: async ({ store }) => {
    await store.setBudget({ day: null, amountMinor: 20_000 });
    await store.setBudget({ day: "2026-11-02", amountMinor: 3_000 });
    const { budgets } = await store.loadDashboard();
    expect(budgets.defaultMinor).toBe(20_000);
    expect([...budgets.overrides]).toEqual([["2026-11-02", 3_000]]);
  },

  clearBudget: async ({ store }) => {
    // A has no budget of its own: clearing B's default and B's day budget finds nothing to remove.
    await store.clearBudget(null);
    await store.clearBudget("2026-11-02");
    const { budgets } = await store.loadDashboard();
    expect(budgets.defaultMinor).toBeNull();
  },

  listDayRates: async ({ store }) => {
    expect(await store.listDayRates("EUR")).toEqual([]);
  },

  listMarketRates: async ({ store }) => {
    // Market rates are shared and hold no group data; B's day rate must not leak into them.
    const rows = await store.listMarketRates("EUR", "2026-11-01", "2026-11-30");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.rate)).not.toContain("9.9");
  },

  setDailyRate: async ({ store, a }) => {
    // Only A's one expense on the day is on offer; B's expense on the same day is not counted or moved.
    const offer = await store.setDailyRate({
      day: "2026-11-02",
      currency: "EUR",
      rate: parseRate("1.6"),
    });
    expect(offer).toEqual({ expenses: 1, settlements: 0, wouldChange: 1 });
    expect((await store.listDayRates("EUR")).map((row) => row.rate)).toEqual(["1.6"]);
    const history = await store.expenseHistory(a.expense.id);
    expect(history.map((entry) => entry.action)).not.toContain("expense.reprice");
  },

  clearDailyRate: async ({ store }) => {
    // Only B has a day rate on that day; A clearing "its" rate removes nothing of B's.
    const offer = await store.clearDailyRate({ day: "2026-11-02", currency: "EUR" });
    expect(offer).toEqual({ expenses: 1, settlements: 0, wouldChange: 0 });
  },

  repriceDay: async ({ store, a, b }) => {
    // B's day rate of 9.9 must not reach A's expense, and A's re-price must not reach B's.
    const result = await store.repriceDay({ day: "2026-11-02", currency: "EUR" });
    expect([result.expenses, result.settlements]).toEqual([1, 0]);
    expect(result.changes).toEqual([]);
    expect(result.changes.map((c) => c.id)).not.toContain(b.expense.id);
    const history = await store.expenseHistory(a.expense.id);
    expect(history.length).toBeGreaterThan(0);
  },
};

describe("every data layer method is scoped to the caller's group", () => {
  it("has a probe for every method of the store", async () => {
    const world = await buildWorld();
    const methods = Object.keys(world.store).filter((key) => key !== "session");
    expect(methods.sort()).toEqual(Object.keys(probes).sort());
  });

  for (const method of Object.keys(probes) as ScopedMethod[]) {
    it(`${method} never reaches into another group`, async () => {
      const world = await buildWorld();
      const before = await snapshotOfB(world.b.groupId);
      await probes[method](world);
      expect(await snapshotOfB(world.b.groupId)).toEqual(before);
    });
  }

  it("keeps two groups' balances apart", async () => {
    const world = await buildWorld();
    const ledger = await world.store.loadLedger();
    const people = new Set(ledger.members.map((m) => m.userId));
    for (const expense of ledger.expenses) {
      for (const row of [...expense.payers, ...expense.shares]) {
        expect(people.has(row.userId)).toBe(true);
      }
    }
  });

  it("writes every audit row with the caller's group", async () => {
    const world = await buildWorld();
    await world.store.deleteExpense(world.a.expense.id);
    await world.store.restoreExpense(world.a.expense.id);
    const rows = await db.select().from(s.auditLog);
    const [group] = await db
      .select({ groupId: s.memberships.groupId })
      .from(s.memberships)
      .where(eq(s.memberships.userId, world.a.userIds[0] ?? ""));
    for (const row of rows) {
      const actorInA = world.a.userIds.includes(row.actorUserId ?? "");
      expect(row.groupId === group?.groupId).toBe(actorInA);
    }
  });
});
