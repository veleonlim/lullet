import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { priceExpenses, summariseLedger, type Member, type StoredExpense } from "@/lib/ledger";
import { createRateBook } from "@/lib/money";
import { buildDashboard, daysSoFar, rollup, scopedDay } from "./aggregate";
import type { BudgetSettings } from "./budget";

const members: Member[] = ["a", "b", "c", "d"].map((id, position) => ({
  userId: id,
  displayName: id.toUpperCase(),
  position,
}));
const order = members.map((m) => m.userId);

let counter = 0;
function expense(overrides: Partial<StoredExpense> = {}): StoredExpense {
  counter += 1;
  return {
    id: `e${String(counter)}`,
    description: "Dinner",
    category: "food",
    spentOn: "2026-11-02",
    amountMinor: 14849,
    currency: "EUR",
    billedAmountMinor: null,
    billedCurrency: null,
    rate: null,
    rateCurrency: null,
    pricedRate: null,
    pricedRateCurrency: null,
    pricedSource: null,
    splitMethod: "equal",
    payers: [{ userId: "a", amountMinor: 14849 }],
    shares: [
      { userId: "a", amountMinor: 3713, weight: null },
      { userId: "b", amountMinor: 3712, weight: null },
      { userId: "c", amountMinor: 3712, weight: null },
      { userId: "d", amountMinor: 3712, weight: null },
    ],
    createdBy: "a",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

const eurDays = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
const book = createRateBook({
  market: eurDays.map((date) => ({ date, currency: "EUR" as const, rate: "1.5" })),
});
const noBudgets: BudgetSettings = { defaultMinor: null, overrides: new Map() };
const now = new Date("2026-11-04T10:00:00Z");

function model(
  expenses: StoredExpense[],
  extra: Partial<Parameters<typeof buildDashboard>[0]> = {},
) {
  return buildDashboard({
    members,
    priced: priceExpenses(expenses, book, order),
    budgets: noBudgets,
    tripStart: null,
    tripEnd: null,
    timeZone: "Europe/Zurich",
    now,
    ...extra,
  });
}

describe("buildDashboard", () => {
  it("buckets expenses by the date written on them and fills the empty days between", () => {
    const m = model([
      expense({ spentOn: "2026-11-02" }),
      expense({
        spentOn: "2026-11-04",
        amountMinor: 1000,
        currency: "SGD",
        payers: [{ userId: "a", amountMinor: 1000 }],
        shares: [
          { userId: "a", amountMinor: 250, weight: null },
          { userId: "b", amountMinor: 250, weight: null },
          { userId: "c", amountMinor: 250, weight: null },
          { userId: "d", amountMinor: 250, weight: null },
        ],
      }),
    ]);
    expect(m.days.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(m.days.map((d) => d.totalMinor)).toEqual([22274, 0, 1000]);
    expect(m.days.map((d) => d.timing)).toEqual(["past", "past", "today"]);
  });

  it("reports totals that equal the ledger's total spend exactly", () => {
    const expenses = [
      expense({ spentOn: "2026-11-01" }),
      expense({
        spentOn: "2026-11-02",
        amountMinor: 999,
        shares: [
          { userId: "a", amountMinor: 500, weight: null },
          { userId: "c", amountMinor: 499, weight: null },
        ],
        payers: [{ userId: "c", amountMinor: 999 }],
      }),
      expense({
        spentOn: "2026-11-04",
        amountMinor: 1,
        shares: [{ userId: "d", amountMinor: 1, weight: null }],
        payers: [{ userId: "d", amountMinor: 1 }],
      }),
    ];
    const m = model(expenses);
    const summary = summariseLedger({ memberOrder: order, expenses, settlements: [], book });
    expect(m.totalMinor).toBe(summary.totalSpendMinor);
    expect(m.days.reduce((sum, d) => sum + d.totalMinor, 0)).toBe(summary.totalSpendMinor);
    expect(Object.values(m.memberTotals).reduce((a, b) => a + b, 0)).toBe(summary.totalSpendMinor);
    expect(Object.values(m.categoryTotals).reduce((a, b) => a + b, 0)).toBe(
      summary.totalSpendMinor,
    );
    // Each member's total is their share, which is also the "owed" side of the balances.
    for (const entry of summary.balances.reporting) {
      expect(m.memberTotals[entry.memberId]).toBe(entry.owedMinor);
    }
  });

  it("counts a member's share rather than who paid", () => {
    const m = model([expense()]);
    const day = m.days[0];
    expect(day?.byMember).toEqual({ a: 5570, b: 5568, c: 5568, d: 5568 });
    expect(Object.values(day?.byMember ?? {}).reduce((a, b) => a + b, 0)).toBe(day?.totalMinor);
  });

  it("splits a day by category, and each member's share by category too", () => {
    const m = model([
      expense({ category: "food" }),
      expense({
        category: "transport",
        amountMinor: 1200,
        shares: [
          { userId: "a", amountMinor: 600, weight: null },
          { userId: "b", amountMinor: 600, weight: null },
        ],
        payers: [{ userId: "a", amountMinor: 1200 }],
      }),
    ]);
    const day = m.days[0];
    expect(day?.byCategory.food).toBe(22274);
    expect(day?.byCategory.transport).toBe(1800);
    expect(day?.byCategory.stay).toBe(0);
    expect(day?.byMemberCategory.b?.transport).toBe(900);
    expect(day?.byMemberCategory.c?.transport).toBe(0);
  });

  it("uses the billed SGD figure and the day rate through the usual precedence", () => {
    const withDayRate = createRateBook({
      market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }],
      overrides: [{ date: "2026-11-02", currency: "EUR", rate: "2" }],
    });
    const m = buildDashboard({
      members,
      priced: priceExpenses(
        [
          expense({
            amountMinor: 10000,
            shares: [{ userId: "a", amountMinor: 10000, weight: null }],
            payers: [{ userId: "a", amountMinor: 10000 }],
          }),
          expense({
            billedAmountMinor: 12345,
            billedCurrency: "SGD",
            amountMinor: 8000,
            shares: [{ userId: "b", amountMinor: 8000, weight: null }],
            payers: [{ userId: "b", amountMinor: 8000 }],
          }),
        ],
        withDayRate,
        order,
      ),
      budgets: noBudgets,
      tripStart: null,
      tripEnd: null,
      timeZone: "Europe/Zurich",
      now,
    });
    expect(m.days[0]?.byMember).toMatchObject({ a: 20000, b: 12345 });
  });

  it("keeps an expense without a rate out of every figure but still lists it", () => {
    const unpriced = expense({ currency: "CHF", spentOn: "2026-11-03" });
    const m = model([expense(), unpriced]);
    expect(m.unpricedCount).toBe(1);
    const day = m.days.find((d) => d.date === "2026-11-03");
    expect(day?.totalMinor).toBe(0);
    expect(day?.unpricedCount).toBe(1);
    expect(day?.expenses.map((e) => e.expense.id)).toEqual([unpriced.id]);
  });

  it("works out today in the trip's time zone, not the server's", () => {
    const lateUtc = new Date("2026-11-03T23:30:00Z");
    expect(model([expense({ spentOn: "2026-11-03" })], { now: lateUtc }).today).toBe("2026-11-04");
    expect(
      model([expense({ spentOn: "2026-11-03" })], { now: lateUtc, timeZone: "UTC" }).today,
    ).toBe("2026-11-03");
  });

  it("applies a day's own budget over the default and splits it between members", () => {
    const budgets: BudgetSettings = {
      defaultMinor: 20000,
      overrides: new Map([["2026-11-03", 10001]]),
    };
    const m = model([expense()], { budgets });
    const [d2, d3] = m.days;
    expect(d2?.budgetMinor).toBe(20000);
    expect(d2?.budgetSource).toBe("default");
    expect(d2?.memberBudgets).toEqual({ a: 5000, b: 5000, c: 5000, d: 5000 });
    expect(d3?.budgetMinor).toBe(10001);
    expect(d3?.budgetSource).toBe("override");
    expect(d3?.memberBudgets).toEqual({ a: 2501, b: 2500, c: 2500, d: 2500 });
    expect(m.hasBudget).toBe(true);
  });

  it("extends the trip to include days outside the trip's dates", () => {
    const m = model([expense({ spentOn: "2026-10-30", currency: "SGD" })], {
      tripStart: "2026-11-02",
      tripEnd: "2026-11-05",
    });
    expect(m.range).toEqual({ start: "2026-10-30", end: "2026-11-05" });
    expect(m.totalMinor).toBe(14849);
  });

  it("holds together for any mix of expenses (property)", () => {
    const arbExpense = fc
      .record({
        day: fc.integer({ min: 1, max: 5 }),
        amount: fc.integer({ min: 1, max: 500000 }),
        category: fc.constantFrom("food", "transport", "stay", "sightseeing", "shopping", "other"),
        payer: fc.constantFrom(...order),
        sharers: fc.subarray(order, { minLength: 1 }),
      })
      .map(({ day, amount, category, payer, sharers }) => {
        const each = Math.floor(amount / sharers.length);
        const rest = amount - each * sharers.length;
        return expense({
          spentOn: `2026-11-0${String(day)}`,
          amountMinor: amount,
          category,
          payers: [{ userId: payer, amountMinor: amount }],
          shares: sharers.map((userId, i) => ({
            userId,
            amountMinor: each + (i < rest ? 1 : 0),
            weight: null,
          })),
        });
      });
    fc.assert(
      fc.property(fc.array(arbExpense, { maxLength: 12 }), (expenses) => {
        const m = model(expenses);
        const summary = summariseLedger({ memberOrder: order, expenses, settlements: [], book });
        expect(m.totalMinor).toBe(summary.totalSpendMinor);
        for (const day of m.days) {
          expect(Object.values(day.byMember).reduce((a, b) => a + b, 0)).toBe(day.totalMinor);
          expect(Object.values(day.byCategory).reduce((a, b) => a + b, 0)).toBe(day.totalMinor);
        }
      }),
    );
  });
});

describe("scopedDay and rollup", () => {
  const budgets: BudgetSettings = { defaultMinor: 20000, overrides: new Map() };
  const m = model(
    [
      expense({ spentOn: "2026-11-02" }), // S$222.74 against S$200: over
      expense({
        spentOn: "2026-11-03",
        amountMinor: 8000,
        currency: "SGD",
        payers: [{ userId: "a", amountMinor: 8000 }],
        shares: [
          { userId: "a", amountMinor: 2000, weight: null },
          { userId: "b", amountMinor: 2000, weight: null },
          { userId: "c", amountMinor: 2000, weight: null },
          { userId: "d", amountMinor: 2000, weight: null },
        ],
      }), // S$80: under
      expense({
        spentOn: "2026-11-05",
        amountMinor: 17000,
        currency: "SGD",
        payers: [{ userId: "a", amountMinor: 17000 }],
        shares: [{ userId: "a", amountMinor: 17000, weight: null }],
      }), // future day, all on member a
    ],
    { budgets, tripStart: "2026-11-02", tripEnd: "2026-11-06" },
  );

  it("compares the group with the group budget", () => {
    const days = m.days.map((d) => scopedDay(d, null));
    expect(days.map((d) => d.state)).toEqual(["over", "under", "under", "near", "under"]);
  });

  it("compares each member's share with the budget divided by the members", () => {
    // On the 5th member a's share (S$170) is far over their S$50 slice though the group is only near its S$200.
    const day5 = m.days.find((d) => d.date === "2026-11-05");
    expect(day5 && scopedDay(day5, null).state).toBe("near");
    expect(day5 && scopedDay(day5, "a")).toMatchObject({
      spentMinor: 17000,
      budgetMinor: 5000,
      state: "over",
    });
    expect(day5 && scopedDay(day5, "b")).toMatchObject({
      spentMinor: 0,
      budgetMinor: 5000,
      state: "under",
    });
  });

  it("rolls up the trip so far, leaving out days still to come", () => {
    const scoped = m.days.map((d) => scopedDay(d, null));
    const sofar = rollup(daysSoFar(scoped));
    // Today is 4 Nov: days 2, 3 and 4 count.
    expect(sofar.days).toBe(3);
    expect(sofar.spentMinor).toBe(22274 + 8000);
    expect(sofar.budgetMinor).toBe(60000);
    expect(sofar.remainingMinor).toBe(60000 - 30274);
    expect(sofar.state).toBe("under");
    expect(sofar.daysOver).toBe(1);
    expect(sofar.averageMinor).toBe(10091);
    const whole = rollup(scoped);
    expect(whole.days).toBe(5);
    expect(whole.spentMinor).toBe(m.totalMinor);
  });

  it("rolls up one member against their share of the budget", () => {
    const sofar = rollup(daysSoFar(m.days.map((d) => scopedDay(d, "b"))));
    expect(sofar.budgetMinor).toBe(15000);
    expect(sofar.spentMinor).toBe(5568 + 2000);
    expect(sofar.state).toBe("under");
  });

  it("has no budget side when no day has a budget", () => {
    const plain = model([expense()]);
    const r = rollup(plain.days.map((d) => scopedDay(d, null)));
    expect(r.budgetMinor).toBeNull();
    expect(r.remainingMinor).toBeNull();
    expect(r.state).toBe("none");
    expect(rollup([])).toMatchObject({ days: 0, averageMinor: 0, state: "none" });
  });
});
