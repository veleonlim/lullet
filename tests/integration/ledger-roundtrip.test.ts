import { eq, isNull } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import {
  computeBalances,
  createRateBook,
  parseRate,
  suggestTransfers,
  type LedgerExpense,
  type RateBook,
} from "@/lib/money";
import { arbLedger } from "@/test-support/arbitraries";
import { closeTestDb, insertExpense, resetDatabase, seedGroup, testDb, type Seed } from "./helpers";

const db = testDb();

beforeEach(() => resetDatabase(db));
afterAll(closeTestDb);

/** Reads the active ledger back from Postgres in the shape the money library wants. */
async function loadLedger(
  seed: Seed,
): Promise<{ expenses: LedgerExpense[]; rates: RateBook; members: string[] }> {
  const memberRows = await db
    .select()
    .from(s.memberships)
    .where(eq(s.memberships.groupId, seed.groupId))
    .orderBy(s.memberships.position);
  const expenseRows = await db
    .select()
    .from(s.expenses)
    .where(eq(s.expenses.groupId, seed.groupId));
  const active = expenseRows.filter((e) => e.deletedAt === null);
  const payers = await db.select().from(s.expensePayers);
  const shares = await db.select().from(s.expenseShares);
  const marketRows = await db.select().from(s.fxRates);
  const dayRows = await db
    .select()
    .from(s.dailyRates)
    .where(eq(s.dailyRates.groupId, seed.groupId));

  const expenses = active.map((row): LedgerExpense => ({
    id: row.id,
    date: row.spentOn,
    amountMinor: row.amountMinor,
    currency: row.currency as LedgerExpense["currency"],
    billed:
      row.billedAmountMinor !== null && row.billedCurrency !== null
        ? { amountMinor: row.billedAmountMinor, currency: row.billedCurrency as "SGD" }
        : undefined,
    rate: row.rate === null ? undefined : parseRate(row.rate),
    payers: payers
      .filter((p) => p.expenseId === row.id)
      .map((p) => ({ memberId: p.userId, minor: p.amountMinor })),
    shares: shares
      .filter((p) => p.expenseId === row.id)
      .map((p) => ({ memberId: p.userId, minor: p.amountMinor })),
  }));
  const asEntry = (r: { rateDate: string; base: string; rate: string }) => ({
    date: r.rateDate,
    currency: r.base as "EUR",
    rate: r.rate,
  });
  return {
    members: memberRows.map((m) => m.userId),
    expenses,
    rates: createRateBook({ market: marketRows.map(asEntry), overrides: dayRows.map(asEntry) }),
  };
}

describe("the ledger survives a round trip through Postgres", () => {
  it("reads back the report example and balances it", async () => {
    const seed = await seedGroup(db, 4);
    const [a, b, c, d] = seed.userIds as [string, string, string, string];
    await db.insert(s.fxRates).values({
      rateDate: "2026-11-02",
      base: "EUR",
      quote: "SGD",
      rate: "1.4344",
      sourceDate: "2026-11-02",
    });
    const rows: [number, string[], number[]][] = [
      [4850, [b, c, d], [1617, 1617, 1616]],
      [1200, [b, c, d], [400, 400, 400]],
      [2399, [b, c, d], [800, 800, 799]],
      [6400, [c, d], [3200, 3200]],
    ];
    for (const [amountMinor, who, split] of rows) {
      await insertExpense(db, {
        seed,
        amountMinor,
        payers: [{ userId: a, amountMinor }],
        shares: who.map((userId, i) => ({ userId, amountMinor: split[i] ?? 0 })),
      });
    }
    const ledger = await loadLedger(seed);
    const { byCurrency, reporting } = computeBalances(ledger);
    expect(byCurrency.EUR?.map((m) => m.balanceMinor)).toEqual([14849, -2817, -6017, -6015]);
    expect(reporting.reduce((sum, m) => sum + m.balanceMinor, 0)).toBe(0);
    expect(suggestTransfers(reporting)).toHaveLength(3);
  });

  it("ignores soft deleted expenses", async () => {
    const seed = await seedGroup(db, 2);
    const [a, b] = seed.userIds as [string, string];
    const id = await insertExpense(db, {
      seed,
      currency: "SGD",
      amountMinor: 1000,
      payers: [{ userId: a, amountMinor: 1000 }],
      shares: [{ userId: b, amountMinor: 1000 }],
    });
    await db
      .update(s.expenses)
      .set({ deletedAt: new Date(), deletedBy: a })
      .where(eq(s.expenses.id, id));
    const ledger = await loadLedger(seed);
    expect(ledger.expenses).toHaveLength(0);
    expect(await db.select().from(s.expenses).where(isNull(s.expenses.deletedAt))).toHaveLength(0);
  });

  it("random ledgers stored in Postgres always balance to zero when read back", async () => {
    await fc.assert(
      fc.asyncProperty(arbLedger(4), async (generated) => {
        await resetDatabase(db);
        const seed = await seedGroup(db, 4);
        const ids = new Map(generated.members.map((m, i) => [m, seed.userIds[i] ?? ""] as const));
        const map = (memberId: string) => ids.get(memberId) ?? "";

        await db.insert(s.fxRates).values([
          ...["2026-11-01", "2026-11-02", "2026-11-03"].flatMap((rateDate) => [
            { rateDate, base: "EUR", quote: "SGD", rate: "1.4344", sourceDate: rateDate },
            { rateDate, base: "CHF", quote: "SGD", rate: "1.5603", sourceDate: rateDate },
          ]),
        ]);
        await db.insert(s.dailyRates).values({
          groupId: seed.groupId,
          rateDate: "2026-11-02",
          base: "EUR",
          rate: "1.51",
          setBy: seed.userIds[0] ?? "",
        });
        for (const e of generated.expenses) {
          await insertExpense(db, {
            seed,
            amountMinor: e.amountMinor,
            currency: e.currency,
            spentOn: e.date,
            billed: e.billed,
            payers: e.payers
              .map((p) => ({ userId: map(p.memberId), amountMinor: p.minor }))
              .filter((p) => p.amountMinor > 0),
            shares: e.shares.map((p) => ({ userId: map(p.memberId), amountMinor: p.minor })),
          });
        }

        const loaded = await loadLedger(seed);
        const stored = computeBalances(loaded);
        expect(stored.reporting.reduce((sum, m) => sum + m.balanceMinor, 0)).toBe(0);
        for (const list of Object.values(stored.byCurrency)) {
          expect(list.reduce((sum, m) => sum + m.balanceMinor, 0)).toBe(0);
        }

        // The same ledger computed in memory (with ids renamed) gives identical numbers.
        const inMemory = computeBalances({
          members: generated.members,
          expenses: generated.expenses,
          rates: generated.rates,
        });
        expect(stored.reporting.map((m) => m.balanceMinor)).toEqual(
          inMemory.reporting.map((m) => m.balanceMinor),
        );
      }),
      { numRuns: 25 },
    );
  });
});
