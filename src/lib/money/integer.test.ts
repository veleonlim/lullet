import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertNonNegativeMinor,
  assertPositiveMinor,
  assertSafeInteger,
  divRoundHalfUp,
  sum,
  toSafeNumber,
} from "./integer";

describe("integer guards", () => {
  it("rejects floats, NaN, infinities and unsafe integers", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => assertSafeInteger(bad, "x")).toThrow(RangeError);
    }
    expect(() => assertSafeInteger(Number.MAX_SAFE_INTEGER, "x")).not.toThrow();
  });

  it("checks sign", () => {
    expect(() => assertNonNegativeMinor(0, "x")).not.toThrow();
    expect(() => assertNonNegativeMinor(-1, "x")).toThrow(RangeError);
    expect(() => assertPositiveMinor(1, "x")).not.toThrow();
    expect(() => assertPositiveMinor(0, "x")).toThrow(RangeError);
  });

  it("converts bigint back only inside the safe range", () => {
    expect(toSafeNumber(42n, "x")).toBe(42);
    expect(toSafeNumber(-42n, "x")).toBe(-42);
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "x")).toThrow(RangeError);
    expect(() => toSafeNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n, "x")).toThrow(RangeError);
  });

  it("divides rounding half up", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 2n)).toBe(2n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => divRoundHalfUp(-1n, 2n)).toThrow(RangeError);
  });

  it("matches a reference rounding for any non-negative inputs", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (n, d) => {
          const result = divRoundHalfUp(n, d);
          // |n/d - result| <= 1/2, i.e. |2n - 2*result*d| <= d
          const diff = 2n * n - 2n * result * d;
          return (diff < 0n ? -diff : diff) <= d;
        },
      ),
    );
  });

  it("sums without float drift", () => {
    expect(sum([])).toBe(0);
    expect(sum([1, 2, 3])).toBe(6);
    expect(() => sum([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toThrow(RangeError);
  });
});
