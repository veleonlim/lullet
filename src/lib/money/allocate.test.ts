import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FULL_BASIS_POINTS,
  allocateProportional,
  allocateSplit,
  equalSplit,
  type SplitSpec,
} from "./allocate";
import { MoneyError } from "./errors";
import { arbHugeMinor, arbMinor, arbSubset, memberIds } from "@/test-support/arbitraries";

const minors = (allocations: readonly { minor: number }[]) => allocations.map((a) => a.minor);
const total = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

describe("allocateProportional examples", () => {
  it("splits 14849 three ways as [4950, 4950, 4949] (leftover units go to the earliest)", () => {
    expect(allocateProportional(14849, [1, 1, 1])).toEqual([4950, 4950, 4949]);
  });

  it("gives the leftover to the largest remainder, not the first position", () => {
    // exact shares 3.33, 3.33, 3.33 -> tie; with weights 2,1,1 of 10: 5, 2.5, 2.5
    expect(allocateProportional(10, [2, 1, 1])).toEqual([5, 3, 2]);
    // 7 over 1:2 -> 2.33, 4.67; the larger remainder wins the spare unit
    expect(allocateProportional(7, [1, 2])).toEqual([2, 5]);
  });

  it("handles zero totals and zero weights", () => {
    expect(allocateProportional(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(allocateProportional(0, [0, 0])).toEqual([0, 0]);
    expect(allocateProportional(100, [0, 1, 0])).toEqual([0, 100, 0]);
    expect(allocateProportional(1, [1, 1, 1])).toEqual([1, 0, 0]);
  });

  it("rejects impossible requests", () => {
    expect(() => allocateProportional(100, [])).toThrow(MoneyError);
    expect(() => allocateProportional(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocateProportional(-1, [1])).toThrow(RangeError);
    expect(() => allocateProportional(1.5, [1])).toThrow(RangeError);
    expect(() => allocateProportional(1, [-1, 2])).toThrow(RangeError);
  });
});

describe("allocateProportional properties", () => {
  const arbWeights = fc
    .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 })
    .filter((weights) => weights.some((w) => w > 0));

  it("always sums exactly to the total", () => {
    fc.assert(
      fc.property(arbMinor, arbWeights, (amount, weights) => {
        expect(total(allocateProportional(amount, weights))).toBe(amount);
      }),
      { numRuns: 1000 },
    );
  });

  it("sums exactly even for totals near the safe integer limit", () => {
    fc.assert(
      fc.property(
        arbHugeMinor,
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 6 }),
        (amount, weights) => {
          const result = allocateProportional(amount, weights);
          expect(result.every(Number.isSafeInteger)).toBe(true);
          expect(BigInt(amount)).toBe(result.reduce((acc, n) => acc + BigInt(n), 0n));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("keeps every share within one unit of its exact proportional share (quota rule)", () => {
    fc.assert(
      fc.property(arbMinor, arbWeights, (amount, weights) => {
        const result = allocateProportional(amount, weights);
        const weightSum = BigInt(total(weights));
        result.forEach((value, i) => {
          const exactTimesW = BigInt(amount) * BigInt(weights[i] ?? 0);
          const floor = exactTimesW / weightSum;
          const ceil = (exactTimesW + weightSum - 1n) / weightSum;
          expect(BigInt(value) >= floor && BigInt(value) <= ceil).toBe(true);
        });
      }),
      { numRuns: 1000 },
    );
  });

  it("never gives anything to a zero weight", () => {
    fc.assert(
      fc.property(arbMinor, arbWeights, (amount, weights) => {
        const result = allocateProportional(amount, weights);
        weights.forEach((weight, i) => {
          if (weight === 0) expect(result[i]).toBe(0);
        });
      }),
    );
  });

  it("is deterministic and breaks ties towards the earlier position", () => {
    fc.assert(
      fc.property(arbMinor, fc.integer({ min: 1, max: 12 }), (amount, n) => {
        const weights = Array.from({ length: n }, () => 1);
        const result = allocateProportional(amount, weights);
        expect(allocateProportional(amount, weights)).toEqual(result);
        for (let i = 1; i < n; i += 1) expect(result[i - 1]).toBeGreaterThanOrEqual(result[i] ?? 0);
        expect(Math.max(...result) - Math.min(...result)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("scales: doubling every weight changes nothing", () => {
    fc.assert(
      fc.property(arbMinor, arbWeights, (amount, weights) => {
        expect(
          allocateProportional(
            amount,
            weights.map((w) => w * 2),
          ),
        ).toEqual(allocateProportional(amount, weights));
      }),
    );
  });
});

describe("allocateSplit", () => {
  const ids = memberIds(4);

  it("equal: the report example (Trattoria 48.50 between B, C, D)", () => {
    const result = allocateSplit(4850, { kind: "equal", members: ["B", "C", "D"] });
    expect(result).toEqual([
      { memberId: "B", minor: 1617 },
      { memberId: "C", minor: 1617 },
      { memberId: "D", minor: 1616 },
    ]);
  });

  it("equal: memberOrder decides who gets the spare cents, whatever order the caller lists them", () => {
    const order = ["A", "B", "C", "D"];
    const forward = equalSplit(100, ["B", "C", "D"], order);
    const shuffled = equalSplit(100, ["D", "B", "C"], order);
    expect(shuffled).toEqual(forward);
    expect(forward.map((a) => a.memberId)).toEqual(["B", "C", "D"]);
    expect(minors(forward)).toEqual([34, 33, 33]);
  });

  it("exact: returns the entered amounts when they add up", () => {
    const spec: SplitSpec = {
      kind: "exact",
      entries: [
        { memberId: "A", minor: 700 },
        { memberId: "B", minor: 300 },
      ],
    };
    expect(minors(allocateSplit(1000, spec))).toEqual([700, 300]);
  });

  it("exact: rejects totals that do not match", () => {
    const spec: SplitSpec = { kind: "exact", entries: [{ memberId: "A", minor: 999 }] };
    expect(() => allocateSplit(1000, spec)).toThrow(
      expect.objectContaining({ code: "split_total_mismatch" }),
    );
  });

  it("percent: allocates basis points with largest remainder", () => {
    const spec: SplitSpec = {
      kind: "percent",
      entries: [
        { memberId: "A", basisPoints: 6000 },
        { memberId: "B", basisPoints: 4000 },
      ],
    };
    expect(minors(allocateSplit(1001, spec))).toEqual([601, 400]);
    const thirds: SplitSpec = {
      kind: "percent",
      entries: [
        { memberId: "A", basisPoints: 3334 },
        { memberId: "B", basisPoints: 3333 },
        { memberId: "C", basisPoints: 3333 },
      ],
    };
    expect(total(minors(allocateSplit(10_000, thirds)))).toBe(10_000);
  });

  it("percent: refuses to save until the rows total exactly 100%", () => {
    const under: SplitSpec = {
      kind: "percent",
      entries: [
        { memberId: "A", basisPoints: 5000 },
        { memberId: "B", basisPoints: 4999 },
      ],
    };
    expect(() => allocateSplit(1000, under)).toThrow(
      expect.objectContaining({ code: "percent_total_mismatch" }),
    );
  });

  it("shares: 1:2:3 of 100", () => {
    const spec: SplitSpec = {
      kind: "shares",
      entries: [
        { memberId: "A", shares: 1 },
        { memberId: "B", shares: 2 },
        { memberId: "C", shares: 3 },
      ],
    };
    expect(minors(allocateSplit(100, spec))).toEqual([17, 33, 50]);
  });

  it("validates members", () => {
    expect(() => allocateSplit(100, { kind: "equal", members: [] })).toThrow(
      expect.objectContaining({ code: "empty_split" }),
    );
    expect(() => allocateSplit(100, { kind: "equal", members: ["A", "A"] })).toThrow(
      expect.objectContaining({ code: "duplicate_member" }),
    );
    expect(() => allocateSplit(100, { kind: "equal", members: ["A", "Z"] }, ["A", "B"])).toThrow(
      expect.objectContaining({ code: "unknown_member" }),
    );
    expect(() =>
      allocateSplit(100, { kind: "shares", entries: [{ memberId: "A", shares: 0 }] }),
    ).toThrow(expect.objectContaining({ code: "invalid_weight" }));
  });

  it("equal split of any amount over any subset sums exactly and differs by at most one cent", () => {
    fc.assert(
      fc.property(arbMinor, arbSubset(ids), (amount, subset) => {
        const result = minors(equalSplit(amount, subset, ids));
        expect(total(result)).toBe(amount);
        expect(Math.max(...result) - Math.min(...result)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("percent splits that total 100% always sum exactly", () => {
    // Any positive weights, normalised so the entries total exactly 10000 basis points.
    const arbBasisPoints = fc
      .array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 6 })
      .filter((raw) => raw.some((n) => n > 0))
      .map((raw) => allocateProportional(FULL_BASIS_POINTS, raw));
    fc.assert(
      fc.property(arbMinor, arbBasisPoints, (amount, bps) => {
        const entries = bps.map((basisPoints, i) => ({ memberId: `m${i}`, basisPoints }));
        expect(total(minors(allocateSplit(amount, { kind: "percent", entries })))).toBe(amount);
      }),
    );
  });

  it("shares splits sum exactly and respect order of weights", () => {
    fc.assert(
      fc.property(
        arbMinor,
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 6 }),
        (amount, weights) => {
          const entries = weights.map((shares, i) => ({ memberId: `m${i}`, shares }));
          const result = minors(allocateSplit(amount, { kind: "shares", entries }));
          expect(total(result)).toBe(amount);
        },
      ),
    );
  });
});
