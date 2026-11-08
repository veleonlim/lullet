import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { labelEvery, niceCeiling } from "./chart";

describe("niceCeiling", () => {
  it.each([
    [0, 100],
    [1, 1],
    [87, 100],
    [101, 200],
    [20000, 20000],
    [22274, 25000],
    [30001, 50000],
    [520000, 1000000],
  ])("%d rounds up to %d", (value, expected) => {
    expect(niceCeiling(value)).toBe(expected);
  });

  it("is never below the value and never more than double it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), (value) => {
        const ceiling = niceCeiling(value);
        expect(ceiling).toBeGreaterThanOrEqual(value);
        expect(ceiling).toBeLessThanOrEqual(value * 2);
      }),
    );
  });
});

describe("labels", () => {
  it("prints every label for a week and thins them for longer trips", () => {
    expect(labelEvery(7)).toBe(1);
    expect(labelEvery(14)).toBe(2);
    expect(labelEvery(31)).toBe(5);
    expect(labelEvery(0)).toBe(1);
  });
});
