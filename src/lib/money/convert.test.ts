import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRateBook, toReportingCurrency, type ConvertibleAmount } from "./convert";
import { parseRate } from "./rate";
import { arbPositiveMinor, arbTripCurrency } from "@/test-support/arbitraries";

const book = createRateBook({
  overrides: [{ date: "2026-11-02", currency: "EUR", rate: "1.51" }],
  market: [
    { date: "2026-11-02", currency: "EUR", rate: "1.4344" },
    { date: "2026-11-02", currency: "CHF", rate: parseRate("1.5603") },
    { date: "2026-11-03", currency: "EUR", rate: "1.4400" },
  ],
});

const base: ConvertibleAmount = { date: "2026-11-02", amountMinor: 10_000, currency: "EUR" };

describe("toReportingCurrency precedence", () => {
  it("leaves SGD alone", () => {
    expect(toReportingCurrency({ ...base, currency: "SGD", amountMinor: 1234 }, book)).toEqual({
      sgdMinor: 1234,
      source: "native",
      basis: "shown",
    });
  });

  it("ignores any billed or rate data on an amount already in SGD", () => {
    const result = toReportingCurrency(
      {
        ...base,
        currency: "SGD",
        amountMinor: 1234,
        billed: { amountMinor: 1, currency: "SGD" },
        rate: parseRate("9"),
      },
      book,
    );
    expect(result).toEqual({ sgdMinor: 1234, source: "native", basis: "shown" });
  });

  it("1. uses the billed SGD figure exactly, even when every rate exists", () => {
    const result = toReportingCurrency(
      { ...base, billed: { amountMinor: 14_999, currency: "SGD" }, rate: parseRate("2") },
      book,
    );
    expect(result).toEqual({ sgdMinor: 14_999, source: "billed", basis: "billed" });
  });

  it("2. uses the rate set on the expense over the day override and market", () => {
    const result = toReportingCurrency({ ...base, rate: parseRate("1.6") }, book);
    expect(result.source).toBe("expense_rate");
    expect(result.sgdMinor).toBe(16_000);
  });

  it("3. uses the day's default override over the market rate", () => {
    const result = toReportingCurrency(base, book);
    expect(result.source).toBe("day_override");
    expect(result.sgdMinor).toBe(15_100);
  });

  it("4. falls back to the day's market rate", () => {
    const result = toReportingCurrency({ ...base, date: "2026-11-03" }, book);
    expect(result.source).toBe("market");
    expect(result.sgdMinor).toBe(14_400);
    expect(result.rate).toEqual(parseRate("1.44"));
  });

  it("converts a billed amount in another currency at the day's rate, keeping the shown amount for reference", () => {
    // Shown as 100.00 EUR but the card was billed 98.40 CHF: convert the CHF figure.
    const result = toReportingCurrency(
      { ...base, billed: { amountMinor: 9_840, currency: "CHF" } },
      book,
    );
    expect(result).toMatchObject({ source: "market", basis: "billed", sgdMinor: 15_353 }); // 98.40 x 1.5603
    expect(result.rate).toEqual(parseRate("1.5603"));
  });

  it("looks the billed currency up in the day override, not the shown currency", () => {
    const withOverride = createRateBook({
      overrides: [{ date: "2026-11-02", currency: "CHF", rate: "1.6" }],
      market: [
        { date: "2026-11-02", currency: "CHF", rate: "1.5603" },
        { date: "2026-11-02", currency: "EUR", rate: "1.4344" },
      ],
    });
    const result = toReportingCurrency(
      { ...base, billed: { amountMinor: 10_000, currency: "CHF" } },
      withOverride,
    );
    expect(result).toMatchObject({ source: "day_override", basis: "billed", sgdMinor: 16_000 });
  });

  it("applies a rate set on the expense to the billed currency", () => {
    const result = toReportingCurrency(
      { ...base, billed: { amountMinor: 10_000, currency: "CHF" }, rate: parseRate("1.7") },
      book,
    );
    expect(result).toMatchObject({ source: "expense_rate", basis: "billed", sgdMinor: 17_000 });
  });

  it("fails when the billed currency has no rate even if the shown currency does", () => {
    expect(() =>
      toReportingCurrency(
        { ...base, date: "2026-11-03", billed: { amountMinor: 9_999, currency: "CHF" } },
        book,
      ),
    ).toThrow(expect.objectContaining({ code: "missing_rate" }));
  });

  it("reports which amount was converted", () => {
    expect(toReportingCurrency(base, book).basis).toBe("shown");
    expect(
      toReportingCurrency({ ...base, billed: { amountMinor: 14_999, currency: "SGD" } }, book)
        .basis,
    ).toBe("billed");
  });

  it("fails loudly when no rate exists, never guessing", () => {
    expect(() => toReportingCurrency({ ...base, date: "2026-11-04" }, book)).toThrow(
      expect.objectContaining({ code: "missing_rate" }),
    );
    expect(() =>
      toReportingCurrency({ ...base, currency: "CHF", date: "2026-11-03" }, book),
    ).toThrow(expect.objectContaining({ code: "missing_rate" }));
  });

  it("validates its inputs", () => {
    expect(() => toReportingCurrency({ ...base, amountMinor: 0 }, book)).toThrow(RangeError);
    expect(() => toReportingCurrency({ ...base, date: "2026-02-30" }, book)).toThrow(RangeError);
    expect(() =>
      toReportingCurrency({ ...base, billed: { amountMinor: 0, currency: "SGD" } }, book),
    ).toThrow(RangeError);
  });

  it("the more specific source always wins, for any amount", () => {
    fc.assert(
      fc.property(
        arbPositiveMinor,
        arbTripCurrency,
        arbPositiveMinor,
        (amountMinor, currency, billedMinor) => {
          if (currency === "SGD") return;
          const withEverything = toReportingCurrency(
            {
              date: "2026-11-02",
              amountMinor,
              currency,
              billed: { amountMinor: billedMinor, currency: "SGD" },
              rate: parseRate("3"),
            },
            book,
          );
          expect(withEverything).toEqual({
            sgdMinor: billedMinor,
            source: "billed",
            basis: "billed",
          });
        },
      ),
    );
  });
});

describe("createRateBook", () => {
  it("returns undefined for unknown days and currencies", () => {
    const empty = createRateBook({});
    expect(empty.market("2026-11-02", "EUR")).toBeUndefined();
    expect(empty.dayOverride("2026-11-02", "EUR")).toBeUndefined();
  });

  it("rejects malformed dates and rates", () => {
    expect(() =>
      createRateBook({ market: [{ date: "nope", currency: "EUR", rate: "1.4" }] }),
    ).toThrow(RangeError);
    expect(() =>
      createRateBook({ market: [{ date: "2026-11-02", currency: "EUR", rate: "x" }] }),
    ).toThrow(expect.objectContaining({ code: "invalid_rate" }));
  });
});
