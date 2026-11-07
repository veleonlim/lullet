import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CURRENCY_CODES, minorUnitExponent, type CurrencyCode } from "./currency";
import { AMOUNT_FORMATS, formatAmount, parseAmount } from "./parse";

function minorOf(text: string, currency: CurrencyCode): number {
  const result = parseAmount(text, { currency });
  if (!result.ok) throw new Error(`expected ${text} to parse, got ${result.reason}`);
  return result.minor;
}

describe("parseAmount: accepted formats", () => {
  it.each([
    // US
    ["1,234.56", "EUR", 123456],
    ["1,234,567.89", "EUR", 123456789],
    ["12.5", "EUR", 1250],
    ["0.99", "EUR", 99],
    [".5", "EUR", 50],
    ["48", "EUR", 4800],
    // EU
    ["48,50", "EUR", 4850],
    ["1.234,56", "EUR", 123456],
    ["1.234.567,89", "EUR", 123456789],
    ["12,5", "EUR", 1250],
    [",99", "EUR", 99],
    // spaces (plain, no-break, narrow no-break, thin)
    ["1 234,56", "EUR", 123456],
    ["1 234,56", "EUR", 123456],
    ["1 234,56", "EUR", 123456],
    ["1 234,56", "EUR", 123456],
    ["1 234 567", "EUR", 123456700],
    // Swiss
    ["1'234.56", "CHF", 123456],
    ["1’234.56", "CHF", 123456],
    ["1'234'567.00", "CHF", 123456700],
    // plain
    ["1234.56", "EUR", 123456],
    ["1234,56", "EUR", 123456],
    ["1234", "EUR", 123400],
    // zero exponent currencies
    ["1234", "JPY", 1234],
    ["1.234", "JPY", 1234],
    ["1,234", "ISK", 1234],
    // thousands only
    ["1,234", "EUR", 123400],
    ["12.345", "EUR", 1234500],
  ] as const)("%s as %s is %i", (text, currency, expected) => {
    expect(minorOf(text, currency)).toBe(expected);
  });

  it("flags a lone separator followed by three digits as an inferred thousands separator", () => {
    const result = parseAmount("1.234", { currency: "EUR" });
    expect(result).toMatchObject({ ok: true, minor: 123400, warnings: ["thousands_inferred"] });
    expect(parseAmount("1,234.00", { currency: "EUR" })).toMatchObject({ warnings: [] });
    expect(parseAmount("12,34", { currency: "EUR" })).toMatchObject({ warnings: [] });
  });

  it("reads currency symbols and codes before or after", () => {
    expect(parseAmount("€48,50")).toMatchObject({ ok: true, minor: 4850, currency: "EUR" });
    expect(parseAmount("48,50 €")).toMatchObject({ ok: true, minor: 4850, currency: "EUR" });
    expect(parseAmount("EUR 48,50")).toMatchObject({ ok: true, minor: 4850, currency: "EUR" });
    expect(parseAmount("48.50 chf")).toMatchObject({ ok: true, minor: 4850, currency: "CHF" });
    expect(parseAmount("CHF 1'234.50")).toMatchObject({ ok: true, minor: 123450, currency: "CHF" });
    expect(parseAmount("Fr. 12.00")).toMatchObject({ ok: true, minor: 1200, currency: "CHF" });
    expect(parseAmount("SFr. 12.00")).toMatchObject({ ok: true, minor: 1200, currency: "CHF" });
    expect(parseAmount("S$12.50")).toMatchObject({ ok: true, minor: 1250, currency: "SGD" });
    expect(parseAmount("US$12.50")).toMatchObject({ ok: true, minor: 1250, currency: "USD" });
    expect(parseAmount("£12.50")).toMatchObject({ ok: true, minor: 1250, currency: "GBP" });
    expect(parseAmount("12,50 zł")).toMatchObject({ ok: true, minor: 1250, currency: "PLN" });
    expect(parseAmount("12,50 Kč")).toMatchObject({ ok: true, minor: 1250, currency: "CZK" });
    expect(parseAmount("120 Ft")).toMatchObject({ ok: true, minor: 12000, currency: "HUF" });
    expect(parseAmount("JPY 1,500")).toMatchObject({ ok: true, minor: 1500, currency: "JPY" });
  });

  it("accepts a matching expected currency alongside the token", () => {
    expect(parseAmount("€48,50", { currency: "EUR" })).toMatchObject({ ok: true, minor: 4850 });
  });

  it("reads negative amounts in all notations", () => {
    for (const text of [
      "-12,00",
      "−12,00",
      "12,00-",
      "(12,00)",
      "-€12,00",
      "€-12,00",
      "12,00 €-",
      "(€12,00)",
    ]) {
      expect(parseAmount(text, { currency: "EUR" })).toMatchObject({ ok: true, minor: -1200 });
    }
    expect(parseAmount("+12,00", { currency: "EUR" })).toMatchObject({ ok: true, minor: 1200 });
  });

  it("never produces negative zero", () => {
    const result = parseAmount("-0,00", { currency: "EUR" });
    expect(result).toMatchObject({ ok: true, minor: 0 });
    expect(Object.is((result as { minor: number }).minor, -0)).toBe(false);
  });
});

describe("parseAmount: rejections", () => {
  it.each([
    ["", "EUR", "empty"],
    ["   ", "EUR", "empty"],
    ["abc", "EUR", "currency_unsupported"],
    ["12 abc 3", "EUR", "invalid_format"],
    ["12.", "EUR", "invalid_format"],
    ["12,", "EUR", "invalid_format"],
    [",", "EUR", "invalid_format"],
    ["1.2.3", "EUR", "invalid_format"],
    ["1,2,3", "EUR", "invalid_format"],
    ["1.234,56,7", "EUR", "invalid_format"],
    ["1,234,56", "EUR", "invalid_format"],
    ["12,34.567,89", "EUR", "invalid_format"],
    ["1234.567.890", "EUR", "invalid_format"],
    ["1 23 456", "EUR", "invalid_format"],
    ["1 234.5.6", "EUR", "invalid_format"],
    ["12 34", "EUR", "invalid_format"],
    ["1.5e3", "EUR", "invalid_format"],
    ["--5", "EUR", "invalid_format"],
    ["(-5)", "EUR", "invalid_format"],
    ["€ €5", "EUR", "invalid_format"],
    ["1.5", "JPY", "too_many_decimals"],
    ["12.345,6789", "EUR", "too_many_decimals"],
    ["0,500", "EUR", "too_many_decimals"],
    ["1.2345", "EUR", "too_many_decimals"],
    ["1 234,567", "EUR", "too_many_decimals"],
    ["99999999999999999999", "EUR", "out_of_range"],
    ["XYZ 12", undefined, "currency_unsupported"],
    ["12,50", undefined, "currency_unknown"],
  ] as const)("%j (%s) fails with %s", (text, currency, reason) => {
    expect(parseAmount(text, currency ? { currency } : {})).toEqual({ ok: false, reason });
  });

  it("does not guess the currency from an ambiguous dollar sign", () => {
    expect(parseAmount("$12.50")).toEqual({ ok: false, reason: "currency_unknown" });
    expect(parseAmount("$12.50", { currency: "EUR" })).toEqual({
      ok: false,
      reason: "currency_mismatch",
    });
    expect(parseAmount("$12.50", { currency: "SGD" })).toMatchObject({
      ok: true,
      minor: 1250,
      currency: "SGD",
    });
    expect(parseAmount("12.50 $", { currency: "USD" })).toMatchObject({
      ok: true,
      minor: 1250,
      currency: "USD",
    });
  });

  it("flags a symbol that contradicts the expected currency", () => {
    expect(parseAmount("€12,50", { currency: "CHF" })).toEqual({
      ok: false,
      reason: "currency_mismatch",
    });
    expect(parseAmount("CHF 12.50", { currency: "EUR" })).toEqual({
      ok: false,
      reason: "currency_mismatch",
    });
  });

  it("rejects two currency tokens", () => {
    expect(parseAmount("EUR 12,50 CHF")).toEqual({ ok: false, reason: "invalid_format" });
  });
});

describe("parseAmount properties", () => {
  it("never throws and only ever returns safe integers", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.constantFrom(...CURRENCY_CODES),
        (text, currency) => {
          const result = parseAmount(text, { currency });
          if (result.ok) expect(Number.isSafeInteger(result.minor)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[-+()0-9.,'   €]{0,20}$/), (text) => {
        const result = parseAmount(text, { currency: "EUR" });
        if (result.ok) expect(Number.isSafeInteger(result.minor)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  const arbAmount = fc.record({
    currency: fc.constantFrom(...CURRENCY_CODES),
    minor: fc.integer({ min: -9_000_000_000_000, max: 9_000_000_000_000 }),
  });

  it.each(Object.entries(AMOUNT_FORMATS))(
    "formatAmount then parseAmount round-trips (%s style)",
    (_name, format) => {
      fc.assert(
        fc.property(arbAmount, ({ currency, minor }) => {
          const text = formatAmount(minor, currency, format);
          expect(parseAmount(text, { currency })).toMatchObject({ ok: true, minor });
          // and with the code attached, with the code leading
          expect(parseAmount(`${currency} ${text}`)).toMatchObject({ ok: true, minor, currency });
        }),
        { numRuns: 1500 },
      );
    },
  );

  it("agrees across the supported display styles for the same value", () => {
    fc.assert(
      fc.property(arbAmount, ({ currency, minor }) => {
        const parsed = [
          AMOUNT_FORMATS.us,
          AMOUNT_FORMATS.eu,
          AMOUNT_FORMATS.swiss,
          AMOUNT_FORMATS.plain,
        ].map((format) => parseAmount(formatAmount(minor, currency, format), { currency }));
        for (const result of parsed) expect(result).toMatchObject({ ok: true, minor });
      }),
    );
  });
});

describe("formatAmount", () => {
  it("prints by exponent and style", () => {
    expect(formatAmount(4850, "EUR", AMOUNT_FORMATS.eu)).toBe("48,50");
    expect(formatAmount(123456, "EUR", AMOUNT_FORMATS.us)).toBe("1,234.56");
    expect(formatAmount(123456, "CHF", AMOUNT_FORMATS.swiss)).toBe("1'234.56");
    expect(formatAmount(123456, "EUR", AMOUNT_FORMATS.eu)).toBe("1.234,56");
    expect(formatAmount(5, "SGD")).toBe("0.05");
    expect(formatAmount(0, "SGD")).toBe("0.00");
    expect(formatAmount(-1234, "JPY", AMOUNT_FORMATS.us)).toBe("-1,234");
    expect(formatAmount(1234, "JPY")).toBe("1234");
    expect(formatAmount(-5, "EUR")).toBe("-0.05");
  });

  it("rejects non integers", () => {
    expect(() => formatAmount(1.5, "EUR")).toThrow(RangeError);
  });

  it("has a digit count that follows the exponent", () => {
    for (const currency of CURRENCY_CODES) {
      const text = formatAmount(7, currency);
      const exponent = minorUnitExponent(currency);
      expect(text.includes(".") ? text.split(".")[1]?.length : 0).toBe(exponent);
    }
  });
});
