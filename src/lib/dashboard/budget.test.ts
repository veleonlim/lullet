import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { budgetFor, budgetState, NEAR_PERCENT, splitBudget } from "./budget";

describe("budgetState", () => {
  it("is none without a budget", () => {
    expect(budgetState(5000, null)).toBe("none");
  });

  it("is under below 80%, near from 80% up to and including 100%, over above", () => {
    expect(NEAR_PERCENT).toBe(80);
    expect(budgetState(7999, 10000)).toBe("under");
    expect(budgetState(8000, 10000)).toBe("near");
    expect(budgetState(9999, 10000)).toBe("near");
    expect(budgetState(10000, 10000)).toBe("near");
    expect(budgetState(10001, 10000)).toBe("over");
  });

  it("treats nothing spent as under, even against a zero budget", () => {
    expect(budgetState(0, 10000)).toBe("under");
    expect(budgetState(0, 0)).toBe("under");
    expect(budgetState(1, 0)).toBe("over");
  });

  it("uses exact integer arithmetic at the 80% edge for awkward budgets", () => {
    // 80% of 12345 is 9876, so 9876 is exactly on the edge and 9875 is just below it.
    expect(budgetState(9875, 12345)).toBe("under");
    expect(budgetState(9876, 12345)).toBe("near");
  });

  it("never gets less severe as spending grows", () => {
    const rank = { none: 0, under: 1, near: 2, over: 3 } as const;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (budget, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(rank[budgetState(high, budget)]).toBeGreaterThanOrEqual(
            rank[budgetState(low, budget)],
          );
        },
      ),
    );
  });
});

describe("budgetFor", () => {
  const settings = { defaultMinor: 20000, overrides: new Map([["2026-11-05", 35000]]) };

  it("prefers the day's own budget, then the default, then none", () => {
    expect(budgetFor("2026-11-05", settings)).toEqual({ amountMinor: 35000, source: "override" });
    expect(budgetFor("2026-11-06", settings)).toEqual({ amountMinor: 20000, source: "default" });
    expect(budgetFor("2026-11-06", { defaultMinor: null, overrides: new Map() })).toEqual({
      amountMinor: null,
      source: "none",
    });
  });

  it("lets an override apply even when there is no default", () => {
    const only = { defaultMinor: null, overrides: new Map([["2026-11-05", 100]]) };
    expect(budgetFor("2026-11-05", only).source).toBe("override");
    expect(budgetFor("2026-11-04", only).source).toBe("none");
  });
});

describe("splitBudget", () => {
  const members = ["a", "b", "c", "d"];

  it("divides the budget by the number of members", () => {
    expect(splitBudget(20000, members)).toEqual({ a: 5000, b: 5000, c: 5000, d: 5000 });
  });

  it("hands spare cents to the first members in the fixed order, losing nothing", () => {
    expect(splitBudget(10001, members)).toEqual({ a: 2501, b: 2500, c: 2500, d: 2500 });
    expect(splitBudget(10003, members)).toEqual({ a: 2501, b: 2501, c: 2501, d: 2500 });
  });

  it("always adds back up to the budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 7 }),
        (budget, count) => {
          const ids = Array.from({ length: count }, (_, i) => `m${String(i)}`);
          const parts = Object.values(splitBudget(budget, ids));
          expect(parts.reduce((a, b) => a + b, 0)).toBe(budget);
          expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("is empty without members", () => {
    expect(splitBudget(100, [])).toEqual({});
  });
});
