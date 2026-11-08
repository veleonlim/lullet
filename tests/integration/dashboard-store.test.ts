import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { scopedDay, rollup } from "@/lib/dashboard";
import {
  expenseSnapshotSchema,
  priceExpenses,
  priceSettlement,
  repriceSnapshotSchema,
  summariseLedger,
  type CategoryId,
} from "@/lib/ledger";
import { parseRate } from "@/lib/money";
import { ConflictError, RateUnavailableError } from "@/server/ledger";
import { loadDashboardModel } from "@/server/dashboard";
import { closeTestDb, expectPgError, PG, resetDatabase, seedGroup, testDb } from "./helpers";
import { expenseInput, FakeFx, RATES, settlementInput, storeFor } from "./ledger-support";

const db = testDb();

beforeEach(() => resetDatabase(db));
afterAll(closeTestDb);

const NOW = new Date("2026-11-04T10:00:00Z");

describe("the dashboard aggregation", () => {
  it("buckets the ledger by day, member and category and matches the ledger's total exactly", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    const [a, b, c, d] = seed.userIds as [string, string, string, string];

    // EUR at the market rate (1.5): S$222.74, shared by four with the spare cent going first.
    await store.createExpense(
      expenseInput(seed, { spentOn: "2026-11-02", category: "food", amount: "148.49" }),
    );
    // Billed in SGD: the exact billed figure counts, not the shown euros.
    await store.createExpense(
      expenseInput(seed, {
        spentOn: "2026-11-02",
        category: "stay",
        description: "Hotel",
        amount: "424.80",
        billed: { amount: "640.00", currency: "SGD" },
      }),
    );
    // Its own rate beats the market rate.
    await store.createExpense(
      expenseInput(seed, {
        spentOn: "2026-11-03",
        category: "shopping",
        description: "Watch",
        amount: "100.00",
        currency: "CHF",
        rate: { rate: "1.75", currency: "CHF" },
      }),
    );
    // Native SGD, only b and c share it.
    await store.createExpense(
      expenseInput(
        seed,
        {
          spentOn: "2026-11-04",
          category: "transport",
          description: "Taxi",
          amount: "30.01",
          currency: "SGD",
          split: {
            mode: "equal",
            members: seed.userIds.map((userId) => ({
              userId,
              included: userId === b || userId === c,
              value: "",
            })),
          },
        },
        1,
      ),
    );
    // A deleted expense counts nowhere.
    const gone = await store.createExpense(
      expenseInput(seed, { spentOn: "2026-11-03", description: "Mistake", amount: "999.00" }),
    );
    await store.deleteExpense(gone.id);

    const { model, data } = await loadDashboardModel(store, NOW);
    const order = data.members.map((m) => m.userId);
    const summary = summariseLedger({
      memberOrder: order,
      expenses: data.expenses,
      settlements: [],
      book: data.book,
    });

    expect(model.range).toEqual({ start: "2026-11-02", end: "2026-11-04" });
    expect(model.days.map((x) => x.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(model.days.map((x) => x.totalMinor)).toEqual([22274 + 64000, 17500, 3001]);

    // Totals match the ledger exactly: overall, per day, per member and per category.
    expect(model.totalMinor).toBe(summary.totalSpendMinor);
    expect(model.days.reduce((sum, x) => sum + x.totalMinor, 0)).toBe(summary.totalSpendMinor);
    for (const entry of summary.balances.reporting) {
      expect(model.memberTotals[entry.memberId]).toBe(entry.owedMinor);
    }
    const categorySum = Object.values(model.categoryTotals).reduce((x, y) => x + y, 0);
    expect(categorySum).toBe(summary.totalSpendMinor);

    const first = model.days[0];
    expect(first?.byCategory.food).toBe(22274);
    expect(first?.byCategory.stay).toBe(64000);
    expect(first?.byMember[a]).toBe(5570 + 16000);
    expect(model.days[1]?.byCategory.shopping).toBe(17500);
    // Taxi: 3001 split between b and c: 1501 goes to the first of them.
    expect(model.days[2]?.byMember).toEqual({ [a]: 0, [b]: 1501, [c]: 1500, [d]: 0 });
    expect(model.days[2]?.byMemberCategory[b]?.transport).toBe(1501 satisfies number);
    expect(Object.keys(model.categoryTotals) as CategoryId[]).toContain("other");
  });

  it("applies the group's budgets and trip dates, per day and per member", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    await store.createExpense(
      expenseInput(seed, { spentOn: "2026-11-03", amount: "100.00", currency: "SGD" }),
    );
    await store.setBudget({ day: null, amountMinor: 20_000 });
    await store.setBudget({ day: "2026-11-03", amountMinor: 10_001 });
    await store.updateTrip({
      tripStart: "2026-11-02",
      tripEnd: "2026-11-05",
      timeZone: "Europe/Zurich",
    });

    const { model } = await loadDashboardModel(store, NOW);
    expect(model.range).toEqual({ start: "2026-11-02", end: "2026-11-05" });
    expect(model.today).toBe("2026-11-04");
    const day3 = model.days.find((x) => x.date === "2026-11-03");
    expect(day3?.budgetMinor).toBe(10_001);
    expect(day3?.budgetSource).toBe("override");
    expect(scopedDay(day3 ?? model.days[0]!, null).state).toBe("near"); // 100.00 of 100.01
    // Each member's S$25.00 share against a quarter of S$100.01 (the spare cent goes to the first member).
    const first = model.members[0]?.userId ?? "";
    const second = model.members[1]?.userId ?? "";
    expect(day3?.memberBudgets[first]).toBe(2501);
    expect(day3?.memberBudgets[second]).toBe(2500);
    expect(scopedDay(day3 ?? model.days[0]!, second).state).toBe("near");

    // So far = up to and including today (4 Nov): 3 days, budgets 200 + 100.01 + 200.
    const sofar = rollup(
      model.days.filter((x) => x.timing !== "future").map((x) => scopedDay(x, null)),
    );
    expect(sofar.days).toBe(3);
    expect(sofar.budgetMinor).toBe(20_000 + 10_001 + 20_000);
    expect(sofar.spentMinor).toBe(10_000);
  });
});

describe("budgets", () => {
  it("keeps one default and one budget per day, and logs every change", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    await store.setBudget({ day: null, amountMinor: 20_000 });
    await store.setBudget({ day: null, amountMinor: 25_000 });
    await store.setBudget({ day: null, amountMinor: 25_000 }); // no change: no audit entry
    await store.setBudget({ day: "2026-11-03", amountMinor: 5_000 });

    const rows = await db.select().from(s.budgets).where(eq(s.budgets.groupId, seed.groupId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.day === null)?.amountMinor).toBe(25_000);
    expect(rows.find((r) => r.day === "2026-11-03")?.setBy).toBe(seed.userIds[0]);

    const audit = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.groupId, seed.groupId), eq(s.auditLog.entityType, "budget")))
      .orderBy(asc(s.auditLog.id));
    expect(audit.map((row) => row.action)).toEqual(["budget.set", "budget.set", "budget.set"]);
    expect(audit[0]).toMatchObject({ before: null, after: { day: null, amountMinor: 20_000 } });
    expect(audit[1]).toMatchObject({
      before: { day: null, amountMinor: 20_000 },
      after: { day: null, amountMinor: 25_000 },
    });

    await store.clearBudget("2026-11-03");
    await store.clearBudget("2026-11-03"); // nothing left to clear
    const { budgets } = await store.loadDashboard();
    expect(budgets.defaultMinor).toBe(25_000);
    expect(budgets.overrides.size).toBe(0);
    const cleared = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "budget.clear"));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.before).toEqual({ day: "2026-11-03", amountMinor: 5_000 });
  });

  it("lets any member change it, recording who did", async () => {
    const seed = await seedGroup(db);
    await storeFor(db, seed, { as: 2 }).setBudget({ day: null, amountMinor: 1_000 });
    const [row] = await db.select().from(s.budgets);
    expect(row?.setBy).toBe(seed.userIds[2]);
  });

  it("refuses a negative budget at the database", async () => {
    const seed = await seedGroup(db);
    await expectPgError(
      db.insert(s.budgets).values({
        groupId: seed.groupId,
        day: null,
        amountMinor: -1,
        setBy: seed.userIds[0] ?? "",
      }),
      { code: PG.checkViolation, constraint: "budgets_amount_check" },
    );
  });
});

describe("trip settings", () => {
  it("saves the dates and time zone and logs a change only when something changed", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    expect((await store.loadDashboard()).timeZone).toBe("Europe/Zurich");

    await store.updateTrip({
      tripStart: "2026-11-01",
      tripEnd: "2026-11-14",
      timeZone: "Europe/Rome",
    });
    await store.updateTrip({
      tripStart: "2026-11-01",
      tripEnd: "2026-11-14",
      timeZone: "Europe/Rome",
    });
    const data = await store.loadDashboard();
    expect([data.tripStart, data.tripEnd, data.timeZone]).toEqual([
      "2026-11-01",
      "2026-11-14",
      "Europe/Rome",
    ]);
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "trip.update"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.before).toMatchObject({ timeZone: "Europe/Zurich", tripStart: null });
  });

  it("refuses a trip that ends before it starts at the database", async () => {
    const seed = await seedGroup(db);
    await expectPgError(
      db
        .update(s.groups)
        .set({ tripStart: "2026-11-10", tripEnd: "2026-11-01" })
        .where(eq(s.groups.id, seed.groupId)),
      { code: PG.checkViolation, constraint: "groups_trip_range_check" },
    );
  });
});

describe("daily exchange rates and re-pricing", () => {
  const day = "2026-11-02";
  const rate = (text: string) => parseRate(text);

  async function sgdFigures(
    store: ReturnType<typeof storeFor>,
  ): Promise<Record<string, number | null>> {
    const data = await store.loadDashboard();
    const order = data.members.map((m) => m.userId);
    return Object.fromEntries(
      priceExpenses(data.expenses, data.book, order).map((p) => [
        p.expense.description,
        p.sgd?.totalMinor ?? null,
      ]),
    );
  }

  /** Every figure a page shows that depends on prices: balances, settle-up, and the dashboard's totals. */
  async function figuresShown(store: ReturnType<typeof storeFor>) {
    const ledger = await store.loadLedger();
    const summary = summariseLedger({
      memberOrder: ledger.members.map((m) => m.userId),
      expenses: ledger.expenses,
      settlements: ledger.settlements,
      book: ledger.book,
    });
    const { model } = await loadDashboardModel(store, NOW);
    return {
      expenses: await sgdFigures(store),
      settlements: ledger.settlements.map((x) => priceSettlement(x, ledger.book)?.sgdMinor ?? null),
      balances: summary.balances.reporting,
      transfers: summary.transfers,
      total: summary.totalSpendMinor,
      dashboardTotal: model.totalMinor,
      dayTotals: model.days.map((x) => [x.date, x.totalMinor]),
    };
  }

  async function seedDay() {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    await store.createExpense(expenseInput(seed, { description: "Market", amount: "100.00" }));
    await store.createExpense(
      expenseInput(seed, {
        description: "Own rate",
        amount: "100.00",
        rate: { rate: "1.7", currency: "EUR" },
      }),
    );
    await store.createExpense(
      expenseInput(seed, {
        description: "Billed",
        amount: "100.00",
        billed: { amount: "123.45", currency: "SGD" },
      }),
    );
    await store.createExpense(
      expenseInput(seed, { description: "Native", amount: "100.00", currency: "SGD" }),
    );
    await store.createExpense(
      expenseInput(seed, { description: "Francs", amount: "100.00", currency: "CHF" }),
    );
    await store.createExpense(
      expenseInput(seed, { description: "Other day", amount: "100.00", spentOn: "2026-11-03" }),
    );
    await store.createSettlement(
      settlementInput(seed, { amount: "10.00", currency: "EUR", settledOn: day }),
    );
    return { seed, store };
  }

  async function stored(description: string) {
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.description, description));
    if (!row) throw new Error(`no expense ${description}`);
    return row;
  }

  const sorted = (figures: readonly (number | null)[]) => figures.map(Number).sort((x, y) => x - y);

  const startingFigures = {
    Market: 15000,
    "Own rate": 17000,
    Billed: 12345,
    Native: 10000,
    Francs: 16000,
    "Other day": 15000,
  };

  it("records the rate each expense and settlement was priced with when it was saved", async () => {
    const { seed, store } = await seedDay();
    expect(await sgdFigures(store)).toMatchObject(startingFigures);

    const priced = async (description: string) => {
      const row = await stored(description);
      return [row.pricedRate, row.pricedRateCurrency, row.pricedSource];
    };
    expect(await priced("Market")).toEqual(["1.5000000000", "EUR", "market"]);
    expect(await priced("Francs")).toEqual(["1.6000000000", "CHF", "market"]);
    // Nothing is stored when no rate prices the amount: its own rate, a billed SGD figure, native SGD.
    expect(await priced("Own rate")).toEqual([null, null, null]);
    expect(await priced("Billed")).toEqual([null, null, null]);
    expect(await priced("Native")).toEqual([null, null, null]);
    const [settlement] = await db.select().from(s.settlements);
    expect([
      settlement?.pricedRate,
      settlement?.pricedRateCurrency,
      settlement?.pricedSource,
    ]).toEqual(["1.5000000000", "EUR", "market"]);

    // A day rate in force when an expense is saved is the rate it is priced with.
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });
    await store.createExpense(expenseInput(seed, { description: "Later", amount: "100.00" }));
    expect(await priced("Later")).toEqual(["1.6000000000", "EUR", "day_override"]);
    // The bank billed francs, so the franc rate is the one stored, not the shown euros' rate.
    await store.createExpense(
      expenseInput(seed, {
        description: "Billed francs",
        amount: "100.00",
        billed: { amount: "50.00", currency: "CHF" },
      }),
    );
    expect(await priced("Billed francs")).toEqual(["1.6000000000", "CHF", "market"]);
  });

  it("keeps an edited expense's figure unless the edit changes what the price depends on", async () => {
    const { seed, store } = await seedDay();
    const market = await stored("Market");
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });
    expect((await sgdFigures(store)).Market).toBe(15000);

    const edit = async (input: Parameters<typeof store.updateExpense>[1]) => {
      const current = await store.getExpense(market.id);
      if (!current) throw new Error("missing expense");
      await store.updateExpense(market.id, input, current.updatedAt);
    };

    // A typo fix after the day rate changed leaves the figure where it was, and history shows no pricing change.
    await edit(expenseInput(seed, { description: "Market stall", amount: "100.00" }));
    expect((await sgdFigures(store))["Market stall"]).toBe(15000);
    expect((await stored("Market stall")).pricedSource).toBe("market");
    // A new amount is priced at the rate the expense already has.
    await edit(expenseInput(seed, { description: "Market stall", amount: "200.00" }));
    expect((await sgdFigures(store))["Market stall"]).toBe(30000);
    const quiet = (await store.expenseHistory(market.id)).filter(
      (h) => h.action === "expense.update",
    );
    expect(quiet).toHaveLength(2);
    for (const entry of quiet) {
      expect(expenseSnapshotSchema.parse(entry.before)).toMatchObject({
        pricedRate: "1.5",
        pricedRateCurrency: "EUR",
        pricedSource: "market",
      });
      expect(expenseSnapshotSchema.parse(entry.after)).toMatchObject({
        pricedRate: "1.5",
        pricedSource: "market",
      });
    }

    // A new day takes that day's rate: here the market rate of 3 Nov.
    await edit(
      expenseInput(seed, { description: "Market stall", amount: "100.00", spentOn: "2026-11-03" }),
    );
    expect((await stored("Market stall")).pricedSource).toBe("market");
    // Another currency takes that currency's rate.
    await edit(
      expenseInput(seed, { description: "Market stall", amount: "100.00", currency: "CHF" }),
    );
    expect((await sgdFigures(store))["Market stall"]).toBe(16000);
    const row = await stored("Market stall");
    expect([row.pricedRate, row.pricedRateCurrency]).toEqual(["1.6000000000", "CHF"]);
    // Back to euros on the day with the day rate: the day rate is the one in force now.
    await edit(expenseInput(seed, { description: "Market stall", amount: "100.00" }));
    expect((await stored("Market stall")).pricedSource).toBe("day_override");
    expect((await sgdFigures(store))["Market stall"]).toBe(16000);
    const moved = (await store.expenseHistory(market.id)).filter(
      (h) => h.action === "expense.update",
    );
    const last = moved.at(-1);
    expect(expenseSnapshotSchema.parse(last?.after)).toMatchObject({
      pricedRate: "1.6",
      pricedSource: "day_override",
    });

    // Its own rate beats the stored one and drops it; taking the own rate away prices it afresh.
    await edit(
      expenseInput(seed, {
        description: "Market stall",
        amount: "100.00",
        rate: { rate: "1.7", currency: "EUR" },
      }),
    );
    expect((await stored("Market stall")).pricedRate).toBeNull();
    expect((await sgdFigures(store))["Market stall"]).toBe(17000);
    await edit(expenseInput(seed, { description: "Market stall", amount: "100.00" }));
    expect((await stored("Market stall")).pricedSource).toBe("day_override");

    // Deleting and restoring never re-prices.
    const francs = await stored("Francs");
    await store.deleteExpense(francs.id);
    await store.setDailyRate({ day, currency: "CHF", rate: rate("2") });
    await store.restoreExpense(francs.id);
    expect((await sgdFigures(store)).Francs).toBe(16000);
  });

  it("edits an expense that keeps its stored rate without needing the exchange rate service", async () => {
    const seed = await seedGroup(db);
    const offline = storeFor(db, seed, { fx: new FakeFx({}) });
    await offline.setDailyRate({ day, currency: "EUR", rate: rate("1.8") });
    const lunch = await offline.createExpense(
      expenseInput(seed, { description: "Lunch", amount: "100.00" }),
    );
    await offline.clearDailyRate({ day, currency: "EUR" });
    expect(await db.select().from(s.fxRates)).toEqual([]);

    const edit = (input: Parameters<typeof offline.updateExpense>[1]) =>
      offline.getExpense(lunch.id).then((current) => {
        if (!current) throw new Error("missing expense");
        return offline.updateExpense(lunch.id, input, current.updatedAt);
      });

    await edit(expenseInput(seed, { description: "Lunch at the market", amount: "100.00" }));
    expect((await sgdFigures(offline))["Lunch at the market"]).toBe(18000);
    expect(await db.select().from(s.fxRates)).toEqual([]);

    // A new day has no stored rate to keep, so it does need the service.
    await expect(
      edit(
        expenseInput(seed, {
          description: "Lunch at the market",
          amount: "100.00",
          spentOn: "2026-11-03",
        }),
      ),
    ).rejects.toBeInstanceOf(RateUnavailableError);
    expect((await stored("Lunch at the market")).spentOn).toBe(day);
  });

  it("saving or removing a day rate moves no expense, balance, settle-up or dashboard figure, and offers a re-price", async () => {
    const { seed, store } = await seedDay();
    const before = await figuresShown(store);

    const saved = await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });
    // "Market" is the one expense on the day that the rate decides, and the euro settlement the one settlement.
    expect(saved).toEqual({ expenses: 1, settlements: 1, wouldChange: 2 });
    expect(await figuresShown(store)).toEqual(before);

    const changed = await store.setDailyRate({ day, currency: "EUR", rate: rate("1.55") });
    expect(changed).toEqual({ expenses: 1, settlements: 1, wouldChange: 2 });
    expect(await figuresShown(store)).toEqual(before);

    const cleared = await store.clearDailyRate({ day, currency: "EUR" });
    expect(cleared).toEqual({ expenses: 1, settlements: 1, wouldChange: 0 });
    expect(await figuresShown(store)).toEqual(before);

    // Only the rate itself was logged: no expense was re-priced.
    const actions = (
      await db
        .select()
        .from(s.auditLog)
        .where(eq(s.auditLog.groupId, seed.groupId))
        .orderBy(asc(s.auditLog.id))
    ).map((row) => row.action);
    expect(actions.filter((a) => a === "daily_rate.set")).toHaveLength(2);
    expect(actions.filter((a) => a === "daily_rate.clear")).toHaveLength(1);
    expect(actions).not.toContain("expense.reprice");
    expect(actions).not.toContain("daily_rate.reprice");
  });

  it("re-prices exactly the expenses the day's rate decides, and the settlements of that day", async () => {
    const { seed, store } = await seedDay();
    const before = await figuresShown(store);
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });

    const result = await store.repriceDay({ day, currency: "EUR" });
    expect([result.expenses, result.settlements]).toEqual([1, 1]);
    expect(result.changes.map((c) => c.description)).toEqual([
      "Market",
      "Settlement of \u20ac10.00",
    ]);
    expect(result.changes[0]).toMatchObject({
      before: { sgdMinor: 15000, source: "market", rate: "1.5" },
      after: { sgdMinor: 16000, source: "day_override", rate: "1.6" },
    });

    // Every other expense keeps its figure: own rate, billed SGD, native SGD, another currency, another day.
    const after = await figuresShown(store);
    expect(after.expenses).toEqual({ ...startingFigures, Market: 16000 });
    expect(after.settlements).toEqual([1600]); // EUR 10.00 at 1.6, was 1500
    expect(before.settlements).toEqual([1500]);
    expect(after.total).toBe(before.total + 1000);
    expect(after.dashboardTotal).toBe(before.dashboardTotal + 1000);
    expect(after.dayTotals).toEqual(
      before.dayTotals.map(([d, total]) => [d, d === day ? Number(total) + 1000 : total]),
    );
    expect(after.balances).not.toEqual(before.balances);

    expect(await store.listDayRates("EUR")).toEqual([{ day, currency: "EUR", rate: "1.6" }]);
    const market = await store.listMarketRates("EUR", "2026-11-01", "2026-11-30");
    expect(market.map((row) => [row.day, row.rate])).toEqual([
      ["2026-11-02", "1.5"],
      ["2026-11-03", "1.5"],
    ]);

    // Audit-logged: the rate itself, the day, and the expense's old and new figure in its history.
    const audit = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.groupId, seed.groupId))
      .orderBy(asc(s.auditLog.id));
    const actions = audit.map((row) => row.action);
    expect(actions.filter((a) => a === "daily_rate.set")).toHaveLength(1);
    expect(actions.filter((a) => a === "expense.reprice")).toHaveLength(1);
    expect(actions.filter((a) => a === "settlement.reprice")).toHaveLength(1);
    const settlementEntry = audit.find((row) => row.action === "settlement.reprice");
    expect(settlementEntry).toMatchObject({ entityType: "settlement" });
    expect(repriceSnapshotSchema.parse(settlementEntry?.before).pricing).toMatchObject({
      sgdMinor: 1500,
      source: "market",
    });
    expect(repriceSnapshotSchema.parse(settlementEntry?.after)).toMatchObject({
      pricing: { sgdMinor: 1600, source: "day_override" },
      settledOn: day,
    });
    const summary = audit.find((row) => row.action === "daily_rate.reprice");
    expect(summary?.after).toMatchObject({
      day,
      currency: "EUR",
      expenses: 1,
      settlements: 1,
      changed: 2,
    });
    const marketId = result.changes[0]?.id ?? "";
    const history = await store.expenseHistory(marketId);
    const entry = history.find((h) => h.action === "expense.reprice");
    expect(entry?.actorUserId).toBe(seed.userIds[0]);
    expect(repriceSnapshotSchema.parse(entry?.before).pricing?.sgdMinor).toBe(15000);
    expect(repriceSnapshotSchema.parse(entry?.after).pricing).toMatchObject({
      sgdMinor: 16000,
      source: "day_override",
    });

    // Re-pricing again finds nothing more to move.
    expect((await store.repriceDay({ day, currency: "EUR" })).changes).toEqual([]);
  });

  it("changes the rate again, and does nothing (and logs nothing) when it is the same", async () => {
    const { store } = await seedDay();
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.60") });
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.55") });
    const rows = await db.select().from(s.dailyRates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rate).toMatch(/^1\.55/);
    const sets = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "daily_rate.set"));
    expect(sets).toHaveLength(2);
    expect(sets[1]?.before).toEqual({ day, currency: "EUR", rate: "1.6" });

    expect((await sgdFigures(store)).Market).toBe(15000);
    const result = await store.repriceDay({ day, currency: "EUR" });
    expect(result.changes[0]).toMatchObject({
      before: { sgdMinor: 15000 },
      after: { sgdMinor: 15500 },
    });
  });

  it("goes back to the stored market rate when the day is re-priced after the day rate is removed", async () => {
    const { store } = await seedDay();
    await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });
    await store.repriceDay({ day, currency: "EUR" });
    expect((await sgdFigures(store)).Market).toBe(16000);

    const offer = await store.clearDailyRate({ day, currency: "EUR" });
    expect(offer).toEqual({ expenses: 1, settlements: 1, wouldChange: 2 });
    expect(await store.listDayRates("EUR")).toEqual([]);
    expect((await sgdFigures(store)).Market).toBe(16000);

    const result = await store.repriceDay({ day, currency: "EUR" });
    expect(result.changes[0]).toMatchObject({
      before: { sgdMinor: 16000, source: "day_override" },
      after: { sgdMinor: 15000, source: "market" },
    });
    expect((await sgdFigures(store)).Market).toBe(15000);
    expect(
      await db.select().from(s.auditLog).where(eq(s.auditLog.action, "daily_rate.clear")),
    ).toHaveLength(1);
    // Removing a rate that is not there is harmless.
    expect(await store.clearDailyRate({ day, currency: "EUR" })).toEqual({
      expenses: 1,
      settlements: 1,
      wouldChange: 0,
    });
  });

  it("removes a day rate without the market, and fetches the market rate only to re-price", async () => {
    const seed = await seedGroup(db);
    // A day rate exists from the start, so no market rate was ever stored for the day.
    const offline = storeFor(db, seed, { fx: new FakeFx({}) });
    await offline.setDailyRate({ day, currency: "EUR", rate: rate("1.8") });
    await offline.createExpense(expenseInput(seed, { description: "Lunch", amount: "100.00" }));
    expect(await db.select().from(s.fxRates)).toEqual([]);
    expect((await sgdFigures(offline)).Lunch).toBe(18000);

    // Removing the rate needs no market rate: the expense keeps the figure it was priced with.
    expect(await offline.clearDailyRate({ day, currency: "EUR" })).toEqual({
      expenses: 1,
      settlements: 0,
      wouldChange: 1,
    });
    expect(await offline.listDayRates("EUR")).toEqual([]);
    expect((await sgdFigures(offline)).Lunch).toBe(18000);

    // Re-pricing to the market needs it: with the market unreachable nothing moves.
    await expect(offline.repriceDay({ day, currency: "EUR" })).rejects.toBeInstanceOf(
      RateUnavailableError,
    );
    expect((await sgdFigures(offline)).Lunch).toBe(18000);
    expect(
      await db.select().from(s.auditLog).where(eq(s.auditLog.action, "expense.reprice")),
    ).toHaveLength(0);

    const online = storeFor(db, seed, { fx: new FakeFx(RATES) });
    const result = await online.repriceDay({ day, currency: "EUR" });
    expect(result.changes[0]).toMatchObject({
      before: { sgdMinor: 18000 },
      after: { sgdMinor: 15000 },
    });
    expect((await db.select().from(s.fxRates))[0]?.rate).toMatch(/^1\.5/);
  });

  it("stores a rate on a record that has none, fetching the market rate first, and logs the day", async () => {
    const seed = await seedGroup(db);
    const offline = storeFor(db, seed, { fx: new FakeFx({}) });
    await offline.setDailyRate({ day, currency: "EUR", rate: rate("1.8") });
    await offline.createExpense(expenseInput(seed, { description: "Lunch", amount: "100.00" }));
    // A record from before rates were kept on it, whose day rate has since gone: nothing prices it.
    await db
      .update(s.expenses)
      .set({ pricedRate: null, pricedRateCurrency: null, pricedSource: null });
    await db.delete(s.dailyRates);
    expect((await sgdFigures(offline)).Lunch).toBeNull();
    await expect(offline.repriceDay({ day, currency: "EUR" })).rejects.toBeInstanceOf(
      RateUnavailableError,
    );
    expect((await stored("Lunch")).pricedRate).toBeNull();

    const online = storeFor(db, seed, { fx: new FakeFx(RATES) });
    const result = await online.repriceDay({ day, currency: "EUR" });
    expect(result.expenses).toBe(1);
    expect((await sgdFigures(online)).Lunch).toBe(15000);
    const lunch = await stored("Lunch");
    expect([lunch.pricedRate, lunch.pricedRateCurrency, lunch.pricedSource]).toEqual([
      "1.5000000000",
      "EUR",
      "market",
    ]);

    const log = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, "daily_rate.reprice"));
    expect(log).toHaveLength(1);
    expect(log[0]?.after).toMatchObject({ day, currency: "EUR", expenses: 1 });
  });

  it("offers and re-prices a day that has only a rate-priced settlement, with one audit row for it", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    const sgdSettlement = await store.createSettlement(
      settlementInput(seed, { amount: "5.00", currency: "SGD", settledOn: day }),
    );
    const euros = await store.createSettlement(
      settlementInput(seed, { amount: "10.00", currency: "EUR", settledOn: day }),
    );
    const before = await figuresShown(store);
    expect(sorted(before.settlements)).toEqual([500, 1500]);

    const offer = await store.setDailyRate({ day, currency: "EUR", rate: rate("1.6") });
    expect(offer).toEqual({ expenses: 0, settlements: 1, wouldChange: 1 });
    expect(await figuresShown(store)).toEqual(before);

    const result = await store.repriceDay({ day, currency: "EUR" });
    expect([result.expenses, result.settlements]).toEqual([0, 1]);
    expect(result.changes).toEqual([
      {
        kind: "settlement",
        id: euros.id,
        description: "Settlement of \u20ac10.00",
        date: day,
        before: { sgdMinor: 1500, source: "market", rate: "1.5" },
        after: { sgdMinor: 1600, source: "day_override", rate: "1.6" },
      },
    ]);
    // Exactly the euro settlement moved: the SGD one and the totals of expenses are as they were.
    const after = await figuresShown(store);
    expect(sorted(after.settlements)).toEqual([500, 1600]);
    expect(after.total).toBe(before.total);
    expect(after.balances).not.toEqual(before.balances);

    const rows = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, "settlement.reprice"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "settlement", entityId: euros.id });
    expect(rows[0]?.entityId).not.toBe(sgdSettlement.id);
    expect(
      await db.select().from(s.auditLog).where(eq(s.auditLog.action, "expense.reprice")),
    ).toHaveLength(0);
    expect((await store.repriceDay({ day, currency: "EUR" })).changes).toEqual([]);
  });

  it("is a recorded no-op when nothing needs re-pricing", async () => {
    const { store } = await seedDay();
    const result = await store.repriceDay({ day, currency: "EUR" });
    expect(result.changes).toEqual([]);
    expect([result.expenses, result.settlements]).toEqual([1, 1]);
    expect(
      await db.select().from(s.auditLog).where(eq(s.auditLog.action, "daily_rate.reprice")),
    ).toHaveLength(1);
    expect(
      await db.select().from(s.auditLog).where(eq(s.auditLog.action, "expense.reprice")),
    ).toHaveLength(0);
  });

  it("has no exchange rate to set, clear or re-price for SGD", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    await expect(
      store.setDailyRate({ day, currency: "SGD", rate: rate("1") }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(store.clearDailyRate({ day, currency: "SGD" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(store.repriceDay({ day, currency: "SGD" })).rejects.toBeInstanceOf(ConflictError);
    expect(await db.select().from(s.dailyRates)).toEqual([]);
  });

  it("leaves deleted expenses alone", async () => {
    const seed = await seedGroup(db);
    const store = storeFor(db, seed);
    const created = await store.createExpense(expenseInput(seed, { amount: "100.00" }));
    await store.deleteExpense(created.id);
    const offer = await store.setDailyRate({ day, currency: "EUR", rate: rate("2") });
    expect(offer).toEqual({ expenses: 0, settlements: 0, wouldChange: 0 });
    expect(await store.repriceDay({ day, currency: "EUR" })).toEqual({
      expenses: 0,
      settlements: 0,
      changes: [],
    });
    await store.restoreExpense(created.id);
    expect((await sgdFigures(store)).Trattoria).toBe(15000);
  });
});
