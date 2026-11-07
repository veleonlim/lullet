import { describe, expect, it } from "vitest";
import { parseRate } from "@/lib/money";
import { describeConversion } from "./conversion";

describe("describeConversion", () => {
  const rate = parseRate("1.5340000000");

  it("says nothing for an amount already in SGD", () => {
    expect(
      describeConversion(
        { currency: "SGD", billedCurrency: null },
        { source: "native", basis: "shown" },
      ),
    ).toEqual({ headline: null, detail: null });
  });

  it("names an exact billed SGD figure", () => {
    expect(
      describeConversion(
        { currency: "EUR", billedCurrency: "SGD" },
        { source: "billed", basis: "billed" },
      ).headline,
    ).toBe("Exact figure billed by your bank in SGD");
  });

  it.each([
    ["expense_rate", "Your rate S$1.534 per EUR"],
    ["day_override", "Day rate S$1.534 per EUR"],
    ["market", "Market rate S$1.534 per EUR"],
  ] as const)("describes a %s conversion of the shown amount", (source, headline) => {
    expect(
      describeConversion(
        { currency: "EUR", billedCurrency: null },
        { source, basis: "shown", rate },
      ),
    ).toEqual({ headline, detail: null });
  });

  it("says when the billed amount in another currency was the one converted", () => {
    expect(
      describeConversion(
        { currency: "EUR", billedCurrency: "CHF" },
        { source: "market", basis: "billed", rate },
      ),
    ).toEqual({
      headline: "Market rate S$1.534 per CHF",
      detail: "Converted from the amount your bank billed in CHF",
    });
  });

  it("does not invent a rate that is missing", () => {
    expect(
      describeConversion(
        { currency: "EUR", billedCurrency: null },
        { source: "market", basis: "shown" },
      ).headline,
    ).toBe("Market rate S$? per EUR");
  });
});
