import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { minorUnitExponent } from "./currency";
import { convertMinor, formatRate, parseRate, rateEquals, rateFromNumber } from "./rate";
import { arbCurrency, arbHugeMinor, arbMinor, arbRate } from "@/test-support/arbitraries";

describe("rates", () => {
  it("parses plain decimals exactly and drops trailing zeros", () => {
    expect(parseRate("1.4344")).toEqual({ numerator: 14344n, scale: 4 });
    expect(parseRate("1.4344000000")).toEqual({ numerator: 14344n, scale: 4 });
    expect(parseRate("2")).toEqual({ numerator: 2n, scale: 0 });
    expect(parseRate("2.000")).toEqual({ numerator: 2n, scale: 0 });
    expect(parseRate("0.0108")).toEqual({ numerator: 108n, scale: 4 });
    expect(parseRate(" 1.5 ")).toEqual({ numerator: 15n, scale: 1 });
  });

  it.each([
    "",
    "abc",
    "-1.5",
    "1,5",
    "1e3",
    "0",
    "0.000",
    "1.",
    ".5",
    "1.12345678901",
    "12345678901.5",
  ])("rejects %j", (text) => {
    expect(() => parseRate(text)).toThrow(expect.objectContaining({ code: "invalid_rate" }));
  });

  it("accepts the largest value numeric(20,10) holds", () => {
    expect(formatRate(parseRate("9999999999.9999999999"))).toBe("9999999999.9999999999");
  });

  it("formats canonically", () => {
    expect(formatRate({ numerator: 14344n, scale: 4 })).toBe("1.4344");
    expect(formatRate({ numerator: 108n, scale: 4 })).toBe("0.0108");
    expect(formatRate({ numerator: 5n, scale: 0 })).toBe("5");
    expect(formatRate({ numerator: 5n, scale: 3 })).toBe("0.005");
    expect(formatRate({ numerator: 15000n, scale: 4 })).toBe("1.5");
    expect(formatRate({ numerator: 20000n, scale: 4 })).toBe("2");
  });

  it("round-trips text through parse and format", () => {
    fc.assert(
      fc.property(arbRate, (rate) => {
        const text = formatRate(rate);
        expect(rateEquals(parseRate(text), rate)).toBe(true);
        expect(formatRate(parseRate(text))).toBe(text);
      }),
    );
  });

  it("builds a rate from JSON numbers through their shortest decimal text", () => {
    expect(rateFromNumber(1.4344)).toEqual(parseRate("1.4344"));
    expect(rateFromNumber(0.9143)).toEqual(parseRate("0.9143"));
    expect(rateFromNumber(1)).toEqual(parseRate("1"));
    expect(formatRate(rateFromNumber(1e-7))).toBe("0.0000001");
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rateFromNumber(bad)).toThrow(expect.objectContaining({ code: "invalid_rate" }));
    }
  });

  it("round-trips any 4 decimal rate from a JSON number", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999_999 }), (ten_thousandths) => {
        const asNumber = ten_thousandths / 10_000;
        expect(rateFromNumber(asNumber)).toEqual(rateFromNumber(Number(asNumber.toFixed(4))));
        expect(formatRate(rateFromNumber(asNumber))).toBe(
          formatRate({ numerator: BigInt(ten_thousandths), scale: 4 }),
        );
      }),
    );
  });
});

describe("convertMinor", () => {
  it("converts EUR to SGD at a four decimal rate", () => {
    expect(convertMinor(10_000, "EUR", "SGD", parseRate("1.4344"))).toBe(14_344);
    expect(convertMinor(4850, "EUR", "SGD", parseRate("1.4344"))).toBe(6957); // 69.5684
    expect(convertMinor(1, "EUR", "SGD", parseRate("1.4344"))).toBe(1);
  });

  it("rounds half up on the minor unit of the target", () => {
    expect(convertMinor(1, "EUR", "SGD", parseRate("1.5"))).toBe(2); // 1.5 -> 2
    expect(convertMinor(1, "EUR", "SGD", parseRate("1.49"))).toBe(1);
    expect(convertMinor(1, "EUR", "SGD", parseRate("0.5"))).toBe(1); // 0.5 -> 1
    expect(convertMinor(1, "EUR", "SGD", parseRate("0.49"))).toBe(0);
    expect(convertMinor(0, "EUR", "SGD", parseRate("1.5"))).toBe(0);
  });

  it("is symmetric for negative amounts (refunds)", () => {
    expect(convertMinor(-1, "EUR", "SGD", parseRate("1.5"))).toBe(-2);
    expect(convertMinor(-10_000, "EUR", "SGD", parseRate("1.4344"))).toBe(-14_344);
  });

  it("accounts for different exponents", () => {
    // 1000 JPY (exponent 0) at 0.0108 SGD each = 10.80 SGD = 1080 cents
    expect(convertMinor(1000, "JPY", "SGD", parseRate("0.0108"))).toBe(1080);
    // 10.80 SGD at 92.5926 JPY each = 1000.00 JPY
    expect(convertMinor(1080, "SGD", "JPY", parseRate("92.5926"))).toBe(1000);
  });

  it("is exact for huge amounts, where float maths would drift", () => {
    expect(convertMinor(9_007_199_254_740_991, "EUR", "SGD", parseRate("1"))).toBe(
      9_007_199_254_740_991,
    );
    expect(() => convertMinor(9_007_199_254_740_991, "EUR", "SGD", parseRate("2"))).toThrow(
      RangeError,
    );
  });

  it("rejects unsafe inputs", () => {
    expect(() => convertMinor(1.5, "EUR", "SGD", parseRate("1"))).toThrow(RangeError);
  });

  it("is the identity at rate 1 between equal exponents", () => {
    fc.assert(
      fc.property(
        arbHugeMinor,
        fc.constantFrom("EUR", "CHF", "SGD", "GBP"),
        fc.constantFrom("EUR", "CHF", "SGD", "GBP"),
        (minor, from, to) => {
          expect(convertMinor(minor, from, to, parseRate("1"))).toBe(minor);
        },
      ),
    );
  });

  it("is within half a unit of the exact value", () => {
    fc.assert(
      fc.property(arbMinor, arbRate, arbCurrency, arbCurrency, (minor, rate, from, to) => {
        const result = BigInt(convertMinor(minor, from, to, rate));
        const exponentFrom = minorUnitExponent(from);
        const exponentTo = minorUnitExponent(to);
        // exact = minor * numerator * 10^eTo / 10^(scale + eFrom); compare 2*|exact - result| <= 1
        const num = BigInt(minor) * rate.numerator * 10n ** BigInt(exponentTo);
        const den = 10n ** BigInt(rate.scale + exponentFrom);
        const diff = 2n * (num - result * den);
        expect((diff < 0n ? -diff : diff) <= den).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("is monotonic and sub-additive within one unit", () => {
    fc.assert(
      fc.property(arbMinor, arbMinor, arbRate, (a, b, rate) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(convertMinor(low, "EUR", "SGD", rate)).toBeLessThanOrEqual(
          convertMinor(high, "EUR", "SGD", rate),
        );
        const parts = convertMinor(a, "EUR", "SGD", rate) + convertMinor(b, "EUR", "SGD", rate);
        expect(Math.abs(parts - convertMinor(a + b, "EUR", "SGD", rate))).toBeLessThanOrEqual(1);
      }),
    );
  });
});
