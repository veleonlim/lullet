import { describe, expect, it } from "vitest";
import type { StoredExpense } from "@/lib/ledger";
import { createRateBook } from "@/lib/money";
import { convertedCurrency, diffPricing, pricingOf, usesDayRate } from "./reprice";

function expense(overrides: Partial<StoredExpense> = {}): StoredExpense {
  return {
    id: "e1",
    description: "Dinner",
    category: "food",
    spentOn: "2026-11-02",
    amountMinor: 10000,
    currency: "EUR",
    billedAmountMinor: null,
    billedCurrency: null,
    rate: null,
    rateCurrency: null,
    splitMethod: "equal",
    payers: [{ userId: "a", amountMinor: 10000 }],
    shares: [{ userId: "a", amountMinor: 10000, weight: null }],
    createdBy: "a",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

const market = createRateBook({ market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }] });
const withDayRate = createRateBook({
  market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }],
  overrides: [{ date: "2026-11-02", currency: "EUR", rate: "1.6" }],
});

describe("pricingOf", () => {
  it("reports the SGD figure and how it was decided", () => {
    expect(pricingOf(expense(), market)).toEqual({
      sgdMinor: 15000,
      source: "market",
      rate: "1.5",
    });
    expect(pricingOf(expense(), withDayRate)).toEqual({
      sgdMinor: 16000,
      source: "day_override",
      rate: "1.6",
    });
  });

  it("is null when no rate is known, never a guess", () => {
    expect(pricingOf(expense(), createRateBook({}))).toBeNull();
  });
});

describe("usesDayRate", () => {
  it("is true for a foreign amount priced from rates", () => {
    expect(usesDayRate(expense(), "EUR")).toBe(true);
    expect(usesDayRate(expense(), "CHF")).toBe(false);
  });

  it("is false when the amount is in SGD, billed in SGD, or carries its own rate", () => {
    expect(usesDayRate(expense({ currency: "SGD" }), "EUR")).toBe(false);
    expect(usesDayRate(expense({ billedAmountMinor: 100, billedCurrency: "SGD" }), "EUR")).toBe(
      false,
    );
    expect(usesDayRate(expense({ rate: "1.7", rateCurrency: "EUR" }), "EUR")).toBe(false);
  });

  it("follows the billed currency when the bank billed another one", () => {
    const billedChf = expense({ billedAmountMinor: 9000, billedCurrency: "CHF" });
    expect(convertedCurrency(billedChf)).toBe("CHF");
    expect(usesDayRate(billedChf, "CHF")).toBe(true);
    expect(usesDayRate(billedChf, "EUR")).toBe(false);
  });
});

describe("diffPricing", () => {
  it("lists only the expenses whose figure moved, with before and after", () => {
    const moved = expense({ id: "moved" });
    const own = expense({ id: "own", rate: "1.7", rateCurrency: "EUR" });
    const billed = expense({ id: "billed", billedAmountMinor: 12000, billedCurrency: "SGD" });
    const native = expense({ id: "native", currency: "SGD" });
    const changes = diffPricing([moved, own, billed, native], market, withDayRate);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      expenseId: "moved",
      before: { sgdMinor: 15000, source: "market" },
      after: { sgdMinor: 16000, source: "day_override" },
    });
  });

  it("reports an expense that gains a price when a missing rate appears", () => {
    const [change] = diffPricing([expense()], createRateBook({}), market);
    expect(change?.before).toBeNull();
    expect(change?.after?.sgdMinor).toBe(15000);
  });

  it("reports nothing when the rates are the same", () => {
    expect(diffPricing([expense()], market, market)).toEqual([]);
  });

  it("notices a change of source even when the figure is the same", () => {
    const sameRate = createRateBook({
      market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }],
      overrides: [{ date: "2026-11-02", currency: "EUR", rate: "1.50" }],
    });
    const [change] = diffPricing([expense()], market, sameRate);
    expect(change?.before?.source).toBe("market");
    expect(change?.after?.source).toBe("day_override");
  });
});
