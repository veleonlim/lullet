import { describe, expect, it } from "vitest";
import type { StoredExpense, StoredSettlement } from "@/lib/ledger";
import { createRateBook, parseRate } from "@/lib/money";
import {
  convertedCurrency,
  describeCount,
  hasPricedRate,
  planReprice,
  pricingOf,
  usesDayRate,
} from "./reprice";

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
    pricedRate: null,
    pricedRateCurrency: null,
    pricedSource: null,
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

function settlement(overrides: Partial<StoredSettlement> = {}): StoredSettlement {
  return {
    id: "s1",
    fromUserId: "b",
    toUserId: "a",
    amountMinor: 1000,
    currency: "EUR",
    billedAmountMinor: null,
    billedCurrency: null,
    rate: null,
    rateCurrency: null,
    pricedRate: "1.5",
    pricedRateCurrency: "EUR",
    pricedSource: "market",
    settledOn: "2026-11-02",
    note: null,
    createdBy: "b",
    createdAt: new Date(0),
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

describe("planReprice", () => {
  const stored = { pricedRate: "1.5", pricedRateCurrency: "EUR", pricedSource: "market" } as const;

  it("lists only the expenses the day's rate decides, and what moves", () => {
    const moved = expense({ id: "moved", ...stored });
    const own = expense({ id: "own", rate: "1.7", rateCurrency: "EUR" });
    const billed = expense({ id: "billed", billedAmountMinor: 12000, billedCurrency: "SGD" });
    const native = expense({ id: "native", currency: "SGD" });
    const chf = expense({ id: "chf", currency: "CHF" });
    const steps = planReprice([moved, own, billed, native, chf], "EUR", withDayRate);
    expect(steps.map((step) => step.record.id)).toEqual(["moved"]);
    expect(steps[0]?.target).toMatchObject({ currency: "EUR", source: "day_override" });
    expect(steps[0]?.change).toMatchObject({
      kind: "expense",
      id: "moved",
      before: { sgdMinor: 15000, source: "market" },
      after: { sgdMinor: 16000, source: "day_override" },
    });
  });

  it("prices the before from the stored rate, so a changed book alone moves nothing", () => {
    const [step] = planReprice([expense({ id: "e", ...stored })], "EUR", market);
    expect(step?.change).toBeNull();
    const [after] = planReprice([expense({ id: "e", ...stored })], "EUR", withDayRate);
    expect(after?.change?.before?.sgdMinor).toBe(15000);
  });

  it("returns to the market rate when the day rate is gone", () => {
    const fromOverride = expense({
      id: "e",
      pricedRate: "1.6",
      pricedRateCurrency: "EUR",
      pricedSource: "day_override",
    });
    const [step] = planReprice([fromOverride], "EUR", market);
    expect(step?.target).toMatchObject({ source: "market" });
    expect(step?.change).toMatchObject({
      before: { sgdMinor: 16000, source: "day_override" },
      after: { sgdMinor: 15000, source: "market" },
    });
  });

  it("has no target, and a change to no price, when the book has no rate", () => {
    const [step] = planReprice([expense({ id: "e", ...stored })], "EUR", createRateBook({}));
    expect(step?.target).toBeNull();
    expect(step?.change?.after).toBeNull();
  });

  it("notices a change of source even when the figure is the same", () => {
    const sameRate = createRateBook({
      market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }],
      overrides: [{ date: "2026-11-02", currency: "EUR", rate: "1.50" }],
    });
    const [step] = planReprice([expense({ id: "e", ...stored })], "EUR", sameRate);
    expect(step?.change?.before?.source).toBe("market");
    expect(step?.change?.after?.source).toBe("day_override");
  });

  it("includes a record with no stored rate, priced from the book until it is re-priced", () => {
    const [step] = planReprice([expense({ id: "legacy" })], "EUR", market);
    expect(step?.change).toBeNull();
    expect(step?.target).toMatchObject({ source: "market" });
  });
});

describe("hasPricedRate", () => {
  const target = { currency: "EUR", rate: parseRate("1.5"), source: "market" } as const;

  it("compares the rate by value, its currency and its source", () => {
    const same = {
      pricedRate: "1.5000000000",
      pricedRateCurrency: "EUR",
      pricedSource: "market",
    } as const;
    expect(hasPricedRate(same, target)).toBe(true);
    expect(hasPricedRate({ ...same, pricedRate: "1.6" }, target)).toBe(false);
    expect(hasPricedRate({ ...same, pricedSource: "day_override" }, target)).toBe(false);
    expect(
      hasPricedRate({ pricedRate: null, pricedRateCurrency: null, pricedSource: null }, target),
    ).toBe(false);
    expect(
      hasPricedRate({ pricedRate: null, pricedRateCurrency: null, pricedSource: null }, null),
    ).toBe(true);
  });
});

describe("planReprice for settlements", () => {
  it("plans a rate-priced settlement and leaves SGD, billed and own-rate ones alone", () => {
    const steps = planReprice(
      [
        settlement({ id: "foreign" }),
        settlement({
          id: "sgd",
          currency: "SGD",
          pricedRate: null,
          pricedRateCurrency: null,
          pricedSource: null,
        }),
        settlement({ id: "own", rate: "1.7", rateCurrency: "EUR" }),
      ],
      "EUR",
      withDayRate,
    );
    expect(steps.map((step) => step.record.id)).toEqual(["foreign"]);
    expect(steps[0]?.change).toMatchObject({
      kind: "settlement",
      id: "foreign",
      description: "Settlement of \u20ac10.00",
      date: "2026-11-02",
      before: { sgdMinor: 1500, source: "market" },
      after: { sgdMinor: 1600, source: "day_override" },
    });
  });
});

describe("describeCount", () => {
  it.each([
    [0, 0, ""],
    [1, 0, "1 expense"],
    [2, 0, "2 expenses"],
    [0, 1, "1 settlement"],
    [1, 2, "1 expense and 2 settlements"],
  ])("%i expenses and %i settlements read %j", (expenses, settlements, text) => {
    expect(describeCount(expenses, settlements)).toBe(text);
  });
});
