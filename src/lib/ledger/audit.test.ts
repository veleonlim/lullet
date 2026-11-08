import { describe, expect, it } from "vitest";
import {
  auditActionLabel,
  describeExpenseChanges,
  expenseSnapshotSchema,
  settlementSnapshotSchema,
  snapshotExpense,
  snapshotSettlement,
} from "./audit";
import type { StoredExpense, StoredSettlement } from "./types";

const name = (id: string) => ({ a: "Alex", b: "Jamie" })[id] ?? id;

const expense: StoredExpense = {
  id: "e1",
  description: "Trattoria",
  category: "food",
  spentOn: "2026-11-02",
  amountMinor: 4850,
  currency: "EUR",
  billedAmountMinor: null,
  billedCurrency: null,
  rate: "1.5340000000",
  rateCurrency: "EUR",
  pricedRate: null,
  pricedRateCurrency: null,
  pricedSource: null,
  splitMethod: "equal",
  payers: [{ userId: "a", amountMinor: 4850 }],
  shares: [
    { userId: "a", amountMinor: 2425, weight: null },
    { userId: "b", amountMinor: 2425, weight: null },
  ],
  createdBy: "a",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  deletedAt: null,
  deletedBy: null,
};

describe("expense snapshots", () => {
  it("are JSON safe, normalise the rate and parse back", () => {
    const snapshot = snapshotExpense(expense);
    expect(snapshot.rate).toBe("1.534");
    const roundTrip = expenseSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(roundTrip).toEqual(snapshot);
  });

  it("describes only what changed", () => {
    const before = snapshotExpense(expense);
    const after = snapshotExpense({
      ...expense,
      amountMinor: 6000,
      description: "Trattoria Roma",
      payers: [
        { userId: "a", amountMinor: 4000 },
        { userId: "b", amountMinor: 2000 },
      ],
      shares: [
        { userId: "a", amountMinor: 3000, weight: null },
        { userId: "b", amountMinor: 3000, weight: null },
      ],
      billedAmountMinor: 9000,
      billedCurrency: "SGD",
    });
    expect(describeExpenseChanges(before, after, name)).toEqual([
      { label: "Description", from: "Trattoria", to: "Trattoria Roma" },
      { label: "Amount", from: "€48.50", to: "€60.00" },
      { label: "Billed by the bank", from: null, to: "S$90.00" },
      { label: "Paid by", from: "Alex €48.50", to: "Alex €40.00, Jamie €20.00" },
      {
        label: "Shared between",
        from: "Alex €24.25, Jamie €24.25",
        to: "Alex €30.00, Jamie €30.00",
      },
    ]);
  });

  it("lists every fact when an expense is created, and nothing for no change", () => {
    const snapshot = snapshotExpense(expense);
    const created = describeExpenseChanges(null, snapshot, name);
    expect(created.map((c) => c.label)).toEqual([
      "Description",
      "Category",
      "Date",
      "Amount",
      "Exchange rate",
      "Paid by",
      "Split",
      "Shared between",
    ]);
    expect(created.find((c) => c.label === "Exchange rate")?.to).toBe("S$1.534 per EUR");
    expect(describeExpenseChanges(snapshot, snapshot, name)).toEqual([]);
    expect(describeExpenseChanges(null, null, name)).toEqual([]);
  });

  it("shows removed facts as going to nothing", () => {
    const withBilled = snapshotExpense({
      ...expense,
      billedAmountMinor: 100,
      billedCurrency: "CHF",
    });
    const without = snapshotExpense(expense);
    expect(describeExpenseChanges(withBilled, without, name)).toEqual([
      { label: "Billed by the bank", from: "CHF 1.00", to: null },
    ]);
  });

  it("falls back to raw text for unknown currencies", () => {
    const odd = snapshotExpense({ ...expense, currency: "XXX" });
    expect(describeExpenseChanges(null, odd, name).find((c) => c.label === "Amount")?.to).toBe(
      "4850 XXX",
    );
  });
});

describe("settlement snapshots", () => {
  it("are JSON safe and parse back", () => {
    const settlement: StoredSettlement = {
      id: "s1",
      fromUserId: "b",
      toUserId: "a",
      amountMinor: 1000,
      currency: "SGD",
      billedAmountMinor: null,
      billedCurrency: null,
      rate: "1.5",
      rateCurrency: "EUR",
      pricedRate: null,
      pricedRateCurrency: null,
      pricedSource: null,
      settledOn: "2026-11-05",
      note: "cash",
      createdBy: "b",
      createdAt: new Date(0),
      deletedAt: null,
      deletedBy: null,
    };
    const snapshot = snapshotSettlement(settlement);
    expect(settlementSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(snapshotSettlement({ ...settlement, rate: null, rateCurrency: null }).rate).toBeNull();
  });
});

describe("the priced rate in expense snapshots", () => {
  const priced = {
    ...expense,
    pricedRate: "1.5000000000",
    pricedRateCurrency: "EUR",
    pricedSource: "market" as const,
  };

  it("is recorded normalised and parses back", () => {
    const snapshot = snapshotExpense(priced);
    expect(snapshot).toMatchObject({
      pricedRate: "1.5",
      pricedRateCurrency: "EUR",
      pricedSource: "market",
    });
    expect(expenseSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("shows a move of the priced rate as a change, and nothing when the rate is the same", () => {
    const before = snapshotExpense(priced);
    const moved = snapshotExpense({
      ...priced,
      pricedRate: "1.6000000000",
      pricedSource: "day_override",
    });
    expect(describeExpenseChanges(before, moved, name)).toEqual([
      {
        label: "Priced at",
        from: "S$1.5 per EUR (Market rate)",
        to: "S$1.6 per EUR (Day rate)",
      },
    ]);
    expect(
      describeExpenseChanges(
        before,
        snapshotExpense({ ...priced, description: "Typo fixed" }),
        name,
      ),
    ).toEqual([{ label: "Description", from: "Trattoria", to: "Typo fixed" }]);
  });

  it("still reads entries written before the priced rate was kept", () => {
    const { pricedRate, pricedRateCurrency, pricedSource, ...old } = snapshotExpense(priced);
    expect([pricedRate, pricedRateCurrency, pricedSource]).toEqual(["1.5", "EUR", "market"]);
    const parsed = expenseSnapshotSchema.parse(old);
    expect(describeExpenseChanges(null, parsed, name).map((c) => c.label)).not.toContain(
      "Priced at",
    );
  });
});

describe("auditActionLabel", () => {
  it.each([
    ["expense.create", "Added"],
    ["expense.update", "Edited"],
    ["expense.delete", "Deleted"],
    ["expense.restore", "Restored"],
    ["settlement.create", "Recorded a settlement"],
    ["settlement.delete", "Deleted a settlement"],
    ["settlement.restore", "Restored a settlement"],
    ["settlement.reprice", "Re-priced a settlement"],
    ["something.else", "something.else"],
  ])("%s is %s", (action, label) => {
    expect(auditActionLabel(action)).toBe(label);
  });
});
