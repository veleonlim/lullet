import { describe, expect, it } from "vitest";
import { countedAmount, countedText } from "./counted";

const none = { amountMinor: null, currency: null, billedAmountMinor: null, billedCurrency: null };

describe("what a draft row counts for", () => {
  it("counts the billed SGD figure and keeps the receipt amount for reference", () => {
    const row = {
      ...none,
      amountMinor: 10000,
      currency: "EUR" as const,
      billedAmountMinor: 14426,
      billedCurrency: "SGD" as const,
    };
    expect(countedAmount(row)).toEqual({
      amountMinor: 14426,
      currency: "SGD",
      receipt: { amountMinor: 10000, currency: "EUR" },
    });
    expect(countedText(row)).toBe("S$144.26 (€100.00)");
  });

  it("counts the receipt amount when nothing was billed", () => {
    const row = { ...none, amountMinor: 4850, currency: "EUR" as const };
    expect(countedAmount(row)).toEqual({ amountMinor: 4850, currency: "EUR", receipt: null });
    expect(countedText(row)).toBe("€48.50");
  });

  it("does not repeat a billed figure that equals the receipt amount", () => {
    const row = {
      ...none,
      amountMinor: 1200,
      currency: "SGD" as const,
      billedAmountMinor: 1200,
      billedCurrency: "SGD" as const,
    };
    expect(countedText(row)).toBe("S$12.00");
  });

  it("still shows a billed figure when the receipt amount is missing", () => {
    const row = { ...none, billedAmountMinor: 14426, billedCurrency: "SGD" as const };
    expect(countedText(row)).toBe("S$144.26");
  });

  it("is null without any amount", () => {
    expect(countedAmount(none)).toBeNull();
    expect(countedText(none)).toBeNull();
  });
});
