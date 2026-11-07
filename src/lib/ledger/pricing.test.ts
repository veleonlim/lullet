import { describe, expect, it } from "vitest";
import { createRateBook, parseRate, type RateBook } from "@/lib/money";
import {
  expenseMarketRateNeeded,
  marketRateNeeded,
  priceExpenses,
  priceSettlement,
  summariseLedger,
  toLedgerExpense,
} from "./pricing";
import type { StoredExpense, StoredSettlement } from "./types";

const order = ["a", "b", "c", "d"];

function expense(overrides: Partial<StoredExpense> & { id: string }): StoredExpense {
  return {
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

function settlement(overrides: Partial<StoredSettlement> & { id: string }): StoredSettlement {
  return {
    fromUserId: "b",
    toUserId: "a",
    amountMinor: 5000,
    currency: "SGD",
    billedAmountMinor: null,
    billedCurrency: null,
    rate: null,
    rateCurrency: null,
    pricedRate: null,
    pricedRateCurrency: null,
    pricedSource: null,
    settledOn: "2026-11-05",
    note: null,
    createdBy: "b",
    createdAt: new Date(0),
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

const market: RateBook = createRateBook({
  market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }],
});
const none = createRateBook({});

describe("marketRateNeeded", () => {
  const base = { date: "2026-11-02", amountMinor: 1000, currency: "EUR" as const };

  it("asks for the shown currency's rate when nothing else decides the figure", () => {
    expect(marketRateNeeded(base, none)).toBe("EUR");
  });

  it("asks for the billed currency when the bank billed another foreign currency", () => {
    expect(
      marketRateNeeded({ ...base, billed: { amountMinor: 1100, currency: "CHF" } }, none),
    ).toBe("CHF");
  });

  it("needs nothing for SGD, a billed SGD figure, a matching own rate or a day override", () => {
    expect(marketRateNeeded({ ...base, currency: "SGD" }, none)).toBeNull();
    expect(
      marketRateNeeded({ ...base, billed: { amountMinor: 1100, currency: "SGD" } }, none),
    ).toBeNull();
    expect(
      marketRateNeeded({ ...base, rate: { currency: "EUR", rate: parseRate("1.5") } }, none),
    ).toBeNull();
    const override = createRateBook({
      overrides: [{ date: "2026-11-02", currency: "EUR", rate: "1.51" }],
    });
    expect(marketRateNeeded(base, override)).toBeNull();
  });

  it("still needs the market rate when the own rate is for another currency", () => {
    expect(
      marketRateNeeded({ ...base, rate: { currency: "CHF", rate: parseRate("1.5") } }, none),
    ).toBe("EUR");
  });

  it("works on stored expenses", () => {
    expect(expenseMarketRateNeeded(expense({ id: "e" }), none)).toBe("EUR");
    expect(
      expenseMarketRateNeeded(
        expense({ id: "e", billedAmountMinor: 1, billedCurrency: "SGD" }),
        none,
      ),
    ).toBeNull();
  });
});

describe("stored pricing rates", () => {
  const snapshot = {
    pricedRate: "1.4",
    pricedRateCurrency: "EUR",
    pricedSource: "market",
  } as const;

  it("toLedgerExpense hands the stored rate to the money library", () => {
    expect(toLedgerExpense(expense({ id: "e", ...snapshot })).priced).toEqual({
      currency: "EUR",
      rate: parseRate("1.4"),
      source: "market",
    });
    expect(toLedgerExpense(expense({ id: "e" })).priced).toBeUndefined();
  });

  it("an expense with a stored rate needs no market rate", () => {
    expect(expenseMarketRateNeeded(expense({ id: "e", ...snapshot }), none)).toBeNull();
    expect(
      marketRateNeeded(
        {
          date: "2026-11-02",
          amountMinor: 1000,
          currency: "EUR",
          priced: { currency: "EUR", rate: parseRate("1.4"), source: "market" },
        },
        none,
      ),
    ).toBeNull();
  });

  it("prices an expense and a settlement from their stored rate, whatever the book says", () => {
    const moved = createRateBook({
      overrides: [{ date: "2026-11-02", currency: "EUR", rate: "9" }],
      market: [{ date: "2026-11-02", currency: "EUR", rate: "9" }],
    });
    const [priced] = priceExpenses([expense({ id: "e", ...snapshot })], moved, order);
    expect(priced?.sgd?.totalMinor).toBe(20789); // 148.49 x 1.4
    expect(priced?.sgd?.source).toBe("market");
    const eur = settlement({
      id: "s",
      currency: "EUR",
      amountMinor: 1000,
      settledOn: "2026-11-02",
      ...snapshot,
    });
    expect(priceSettlement(eur, moved)?.sgdMinor).toBe(1400);
  });
});

describe("summariseLedger with stored pricing rates", () => {
  const snapshot = {
    pricedRate: "1.4",
    pricedRateCurrency: "EUR",
    pricedSource: "market",
  } as const;

  it("keeps balances, settle-up and totals where they were when the day's rates change", () => {
    const input = {
      memberOrder: order,
      expenses: [expense({ id: "e", ...snapshot })],
      settlements: [],
    };
    const before = summariseLedger({ ...input, book: market });
    const moved = createRateBook({
      overrides: [{ date: "2026-11-02", currency: "EUR", rate: "9" }],
      market: [{ date: "2026-11-02", currency: "EUR", rate: "9" }],
    });
    const after = summariseLedger({ ...input, book: moved });
    expect(after).toEqual(before);
    expect(after.totalSpendMinor).toBe(20789);
  });
});

describe("priceExpenses", () => {
  it("prices what it can and reports the rest without throwing", () => {
    const priced = priceExpenses(
      [expense({ id: "ok" }), expense({ id: "late", spentOn: "2026-11-09" })],
      market,
      order,
    );
    expect(priced[0]?.sgd?.totalMinor).toBe(22274);
    expect(priced[0]?.problem).toBeUndefined();
    expect(priced[1]?.sgd).toBeUndefined();
    expect(priced[1]?.problem).toMatch(/No EUR to SGD rate for 2026-11-09/);
  });
});

describe("summariseLedger", () => {
  it("derives net balances that sum to zero and the fewest transfers", () => {
    const summary = summariseLedger({
      memberOrder: order,
      expenses: [expense({ id: "e1" })],
      settlements: [],
      book: market,
    });
    const net = Object.fromEntries(
      summary.balances.reporting.map((m) => [m.memberId, m.balanceMinor]),
    );
    expect(net.a).toBe(22274 - 5570);
    expect(net.b).toBe(-5568);
    expect(Object.values(net).reduce((x, y) => x + y, 0)).toBe(0);
    expect(summary.transfers).toHaveLength(3);
    expect(summary.totalSpendMinor).toBe(22274);
    expect(summary.unpricedExpenseIds).toEqual([]);
  });

  it("a recorded settlement reduces what is owed", () => {
    const summary = summariseLedger({
      memberOrder: order,
      expenses: [expense({ id: "e1" })],
      settlements: [settlement({ id: "s1", fromUserId: "b", toUserId: "a", amountMinor: 5567 })],
      book: market,
    });
    const b = summary.balances.reporting.find((m) => m.memberId === "b");
    expect(b?.balanceMinor).toBe(-1);
    expect(summary.transfers.some((t) => t.fromMemberId === "b")).toBe(true);
  });

  it("leaves records without a rate out and lists them", () => {
    const summary = summariseLedger({
      memberOrder: order,
      expenses: [expense({ id: "ok" }), expense({ id: "late", spentOn: "2026-11-09" })],
      settlements: [
        settlement({ id: "eur", currency: "EUR", amountMinor: 1000, settledOn: "2026-11-09" }),
        settlement({ id: "sgd" }),
      ],
      book: market,
    });
    expect(summary.unpricedExpenseIds).toEqual(["late"]);
    expect(summary.unpricedSettlementIds).toEqual(["eur"]);
    expect(summary.totalSpendMinor).toBe(22274);
    expect(summary.balances.reporting.reduce((t, m) => t + m.balanceMinor, 0)).toBe(0);
  });

  it("converts the ledger shape without losing the billed amount or rate", () => {
    const ledger = toLedgerExpense(
      expense({
        id: "x",
        billedAmountMinor: 25000,
        billedCurrency: "SGD",
        rate: "1.5",
        rateCurrency: "EUR",
        pricedRate: null,
        pricedRateCurrency: null,
        pricedSource: null,
      }),
    );
    expect(ledger.billed).toEqual({ amountMinor: 25000, currency: "SGD" });
    expect(ledger.rate?.currency).toBe("EUR");
    expect(ledger.payers).toEqual([{ memberId: "a", minor: 14849 }]);
  });
});
