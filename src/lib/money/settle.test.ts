import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EXACT_SETTLE_LIMIT, suggestTransfers, type BalanceEntry, type Transfer } from "./settle";

function apply(
  balances: readonly BalanceEntry[],
  transfers: readonly Transfer[],
): Map<string, number> {
  const result = new Map(balances.map((b) => [b.memberId, b.balanceMinor] as const));
  for (const t of transfers) {
    // paying a debt moves the payer's balance up and the receiver's down
    result.set(t.fromMemberId, (result.get(t.fromMemberId) ?? 0) + t.minor);
    result.set(t.toMemberId, (result.get(t.toMemberId) ?? 0) - t.minor);
  }
  return result;
}

/** Independent reference: the most zero-sum groups by trying every way of splitting off a group. */
function bruteForceMinTransfers(values: readonly number[]): number {
  const nonZero = values.filter((v) => v !== 0);
  const groupsFrom = (remaining: readonly number[]): number => {
    if (remaining.length === 0) return 0;
    const [first, ...rest] = remaining as [number, ...number[]];
    let best = 0;
    // choose which of the others join the first person's group
    for (let mask = 0; mask < 1 << rest.length; mask += 1) {
      const group = [first, ...rest.filter((_, i) => mask & (1 << i))];
      if (group.reduce((a, b) => a + b, 0) !== 0) continue;
      const left = rest.filter((_, i) => !(mask & (1 << i)));
      best = Math.max(best, 1 + groupsFrom(left));
    }
    return best;
  };
  return nonZero.length - groupsFrom(nonZero);
}

const entries = (values: readonly number[]): BalanceEntry[] =>
  values.map((balanceMinor, i) => ({ memberId: `m${i + 1}`, balanceMinor }));

/** Random balances that sum to zero: the last absorbs the rest (`0 - n`, never `-0`). */
const arbZeroSum = (maxPeople: number) =>
  fc
    .array(fc.integer({ min: -50_000, max: 50_000 }), { minLength: 1, maxLength: maxPeople - 1 })
    .map((values) => [...values, 0 - values.reduce((a, b) => a + b, 0)]);

describe("suggestTransfers examples", () => {
  it("returns nothing when everyone is square", () => {
    expect(suggestTransfers(entries([0, 0, 0, 0]))).toEqual([]);
    expect(suggestTransfers([])).toEqual([]);
  });

  it("settles one debt with one transfer", () => {
    expect(suggestTransfers(entries([500, -500]))).toEqual([
      { fromMemberId: "m2", toMemberId: "m1", minor: 500 },
    ]);
  });

  it("splits a debtor's payment across creditors", () => {
    expect(suggestTransfers(entries([1000, 500, -1500]))).toEqual([
      { fromMemberId: "m3", toMemberId: "m1", minor: 1000 },
      { fromMemberId: "m3", toMemberId: "m2", minor: 500 },
    ]);
  });

  it("finds the independent pairs instead of chaining through everyone", () => {
    // Greedy largest-first would need 3 transfers; two disjoint pairs need 2.
    const result = suggestTransfers(entries([1000, -1000, 400, -400]));
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ fromMemberId: "m2", toMemberId: "m1", minor: 1000 });
    expect(result).toContainEqual({ fromMemberId: "m4", toMemberId: "m3", minor: 400 });
  });

  it("uses the report example (B owes 28.17, C 60.17, D 60.15 to A)", () => {
    const result = suggestTransfers([
      { memberId: "A", balanceMinor: 14849 },
      { memberId: "B", balanceMinor: -2817 },
      { memberId: "C", balanceMinor: -6017 },
      { memberId: "D", balanceMinor: -6015 },
    ]);
    expect(result).toEqual([
      { fromMemberId: "B", toMemberId: "A", minor: 2817 },
      { fromMemberId: "C", toMemberId: "A", minor: 6017 },
      { fromMemberId: "D", toMemberId: "A", minor: 6015 },
    ]);
  });

  it("refuses balances that do not sum to zero", () => {
    expect(() => suggestTransfers(entries([100, -99]))).toThrow(
      expect.objectContaining({ code: "unbalanced" }),
    );
  });

  it("is deterministic", () => {
    const input = entries([300, 300, -200, -400]);
    expect(suggestTransfers(input)).toEqual(suggestTransfers(input));
  });
});

describe("suggestTransfers properties", () => {
  it("brings every balance to exactly zero with positive transfers between different people", () => {
    fc.assert(
      fc.property(arbZeroSum(7), (values) => {
        const balances = entries(values);
        const transfers = suggestTransfers(balances);
        for (const t of transfers) {
          expect(t.minor).toBeGreaterThan(0);
          expect(Number.isSafeInteger(t.minor)).toBe(true);
          expect(t.fromMemberId).not.toBe(t.toMemberId);
        }
        for (const remaining of apply(balances, transfers).values()) expect(remaining).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it("only has debtors paying and creditors receiving", () => {
    fc.assert(
      fc.property(arbZeroSum(7), (values) => {
        const balances = entries(values);
        const byId = new Map(balances.map((b) => [b.memberId, b.balanceMinor] as const));
        for (const t of suggestTransfers(balances)) {
          expect(byId.get(t.fromMemberId)).toBeLessThan(0);
          expect(byId.get(t.toMemberId)).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("uses the true minimum number of transfers (checked against a brute force search)", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: -6, max: 6 }), { minLength: 1, maxLength: 8 })
          .map((values) => [...values, 0 - values.reduce((a, b) => a + b, 0)]),
        (values) => {
          expect(suggestTransfers(entries(values))).toHaveLength(bruteForceMinTransfers(values));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never needs more than people - 1 transfers, including the greedy path beyond the exact limit", () => {
    fc.assert(
      fc.property(arbZeroSum(EXACT_SETTLE_LIMIT + 6), (values) => {
        const balances = entries(values);
        const transfers = suggestTransfers(balances);
        expect(transfers.length).toBeLessThanOrEqual(
          Math.max(0, values.filter((v) => v !== 0).length - 1),
        );
        for (const remaining of apply(balances, transfers).values()) expect(remaining).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("handles exactly the largest exact-search group size", () => {
    const values = Array.from({ length: EXACT_SETTLE_LIMIT }, (_, i) =>
      i % 2 === 0 ? 100 + i : -(100 + i - 1),
    );
    const balances = entries([
      ...values.slice(0, -1),
      0 - values.slice(0, -1).reduce((a, b) => a + b, 0),
    ]);
    const transfers = suggestTransfers(balances);
    for (const remaining of apply(balances, transfers).values()) expect(remaining).toBe(0);
  });
});
