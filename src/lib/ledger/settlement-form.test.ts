import { describe, expect, it } from "vitest";
import { blankSettlementForm } from "./form-values";
import { validateSettlementForm, type SettlementFormValues } from "./settlement-form";

const order = ["a", "b", "c"];

function form(overrides: Partial<SettlementFormValues> = {}): SettlementFormValues {
  return {
    ...blankSettlementForm({
      fromUserId: "b",
      toUserId: "a",
      amount: "52.10",
      today: "2026-11-05",
    }),
    ...overrides,
  };
}

function errorsOf(values: unknown) {
  const result = validateSettlementForm(values, order);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("validateSettlementForm", () => {
  it("accepts an SGD settlement between two members", () => {
    const result = validateSettlementForm(form(), order);
    expect(result).toEqual({
      ok: true,
      value: {
        fromUserId: "b",
        toUserId: "a",
        settledOn: "2026-11-05",
        amountMinor: 5210,
        currency: "SGD",
        billed: null,
        rate: null,
        note: null,
      },
    });
  });

  it("keeps a trimmed note, a foreign currency amount and its own rate", () => {
    const result = validateSettlementForm(
      form({
        note: " cash at the hotel ",
        currency: "EUR",
        amount: "30",
        rate: { rate: "1.5", currency: "EUR" },
      }),
      order,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.note).toBe("cash at the hotel");
      expect(result.value.amountMinor).toBe(3000);
      expect(result.value.rate?.currency).toBe("EUR");
    }
  });

  it("applies the billed rules of an expense", () => {
    const result = validateSettlementForm(
      form({ currency: "EUR", amount: "30", billed: { amount: "47.00", currency: "SGD" } }),
      order,
    );
    expect(result.ok && result.value.billed).toEqual({ amountMinor: 4700, currency: "SGD" });
  });

  it("rejects paying yourself and strangers", () => {
    expect(errorsOf(form({ toUserId: "b" })).toUserId).toBe("Pick two different people");
    expect(errorsOf(form({ fromUserId: "zed" })).fromUserId).toBe("Pick who paid");
    expect(errorsOf(form({ toUserId: "zed" })).toUserId).toBe("Pick who received it");
  });

  it("rejects bad amounts, dates, currencies and notes", () => {
    expect(errorsOf(form({ amount: "0" })).amount).toBe("The amount must be more than zero");
    expect(errorsOf(form({ settledOn: "nope" })).settledOn).toBe("Pick a valid date");
    expect(errorsOf(form({ currency: "ZZZ" })).currency).toBe("Pick a supported currency");
    expect(errorsOf(form({ note: "x".repeat(281) })).note).toMatch(/under 280/);
    expect(errorsOf(undefined).form).toMatch(/not understood/);
  });
});
