import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import type { StoredExpense, StoredSettlement } from "@/lib/ledger";
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
  const bSettlement = await storeB.createSettlement(settlementInput(b));
  const bDeletedSettlement = await storeB.deleteSettlement(
    (await storeB.createSettlement(settlementInput(b, { amount: "7.00" }))).id,
  );

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
      expense: bExpense,
      deletedExpense: bDeletedExpense,
      settlement: bSettlement,
      deletedSettlement: bDeletedSettlement,
    },
  };
}

/** Everything stored for group B, to prove a probe changed none of it. */
async function snapshotOfB(groupId: string) {
  const [expenses, payers, shares, settlements, audit] = await Promise.all([
    db.select().from(s.expenses).where(eq(s.expenses.groupId, groupId)),
    db.select().from(s.expensePayers).where(eq(s.expensePayers.groupId, groupId)),
    db.select().from(s.expenseShares).where(eq(s.expenseShares.groupId, groupId)),
    db.select().from(s.settlements).where(eq(s.settlements.groupId, groupId)),
    db.select().from(s.auditLog).where(eq(s.auditLog.groupId, groupId)),
  ]);
  return { expenses, payers, shares, settlements, audit };
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

  rateBookFor: async ({ store, b }) => {
    // Group B has its own day rate; group A must not see it, only the shared market rate.
    await db.insert(s.dailyRates).values({
      groupId: b.groupId,
      rateDate: "2026-11-02",
      base: "EUR",
      rate: "9.9",
      setBy: b.userIds[0] ?? "",
    });
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
