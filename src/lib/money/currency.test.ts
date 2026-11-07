import { describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  REPORTING_CURRENCY,
  assertCurrencyCode,
  isCurrencyCode,
  minorUnitExponent,
} from "./currency";

describe("currency table", () => {
  it("uses SGD as the reporting currency", () => {
    expect(REPORTING_CURRENCY).toBe("SGD");
  });

  it.each([
    ["SGD", 2],
    ["EUR", 2],
    ["CHF", 2],
    ["GBP", 2],
    ["DKK", 2],
    ["NOK", 2],
    ["SEK", 2],
    ["PLN", 2],
    ["CZK", 2],
    ["HUF", 2],
    ["ISK", 0],
    ["JPY", 0],
    ["USD", 2],
  ] as const)("%s has %i minor unit digits", (code, exponent) => {
    expect(minorUnitExponent(code)).toBe(exponent);
  });

  it("only holds three letter upper case ISO codes with exponents 0 to 3", () => {
    for (const code of CURRENCY_CODES) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect([0, 1, 2, 3]).toContain(minorUnitExponent(code));
    }
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });

  it("recognises codes exactly, without prototype keys or case folding", () => {
    expect(isCurrencyCode("EUR")).toBe(true);
    expect(isCurrencyCode("eur")).toBe(false);
    expect(isCurrencyCode("XXX")).toBe(false);
    expect(isCurrencyCode("toString")).toBe(false);
    expect(isCurrencyCode(undefined)).toBe(false);
    expect(isCurrencyCode(978)).toBe(false);
  });

  it("asserts or throws", () => {
    expect(assertCurrencyCode("CHF")).toBe("CHF");
    expect(() => assertCurrencyCode("ZZZ")).toThrow(RangeError);
  });
});
