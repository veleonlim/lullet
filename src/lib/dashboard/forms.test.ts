import { describe, expect, it } from "vitest";
import { validateBudgetForm, validateRateForm, validateTripForm } from "./forms";
import { formatRate } from "@/lib/money";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("validateBudgetForm", () => {
  it("reads a default budget", () => {
    expect(validateBudgetForm(form({ amount: "150" }), { dayRequired: false })).toEqual({
      ok: true,
      value: { day: null, amountMinor: 15000 },
    });
  });

  it("reads a budget for a day", () => {
    expect(
      validateBudgetForm(form({ amount: "99.50", day: "2026-11-03" }), { dayRequired: true }),
    ).toEqual({ ok: true, value: { day: "2026-11-03", amountMinor: 9950 } });
  });

  it("explains what is wrong", () => {
    const result = validateBudgetForm(form({ amount: "", day: "" }), { dayRequired: true });
    expect(result).toEqual({
      ok: false,
      errors: { amount: "Enter an amount", day: "Pick a day" },
    });
    expect(validateBudgetForm(form({ amount: "0" }), { dayRequired: false })).toMatchObject({
      ok: false,
      errors: { amount: "The amount must be more than zero" },
    });
    expect(
      validateBudgetForm(form({ amount: "10", day: "2026-13-40" }), { dayRequired: false }),
    ).toMatchObject({ ok: false, errors: { day: "Pick a valid date" } });
  });
});

describe("validateTripForm", () => {
  it("accepts dates and a time zone, and treats blank dates as unset", () => {
    expect(
      validateTripForm(
        form({ tripStart: "2026-11-01", tripEnd: "2026-11-14", timeZone: "Europe/Rome" }),
      ),
    ).toEqual({
      ok: true,
      value: { tripStart: "2026-11-01", tripEnd: "2026-11-14", timeZone: "Europe/Rome" },
    });
    expect(
      validateTripForm(form({ tripStart: "", tripEnd: "", timeZone: "Europe/Zurich" })),
    ).toEqual({
      ok: true,
      value: { tripStart: null, tripEnd: null, timeZone: "Europe/Zurich" },
    });
  });

  it("refuses a backwards trip, an unknown zone and a trip over a year long", () => {
    expect(
      validateTripForm(form({ tripStart: "2026-11-10", tripEnd: "2026-11-01", timeZone: "UTC" })),
    ).toMatchObject({ ok: false, errors: { tripEnd: "The trip cannot end before it starts" } });
    expect(validateTripForm(form({ timeZone: "Mars/Base" }))).toMatchObject({
      ok: false,
      errors: { timeZone: expect.stringContaining("time zone") as unknown },
    });
    expect(
      validateTripForm(form({ tripStart: "2026-01-01", tripEnd: "2027-06-01", timeZone: "UTC" })),
    ).toMatchObject({ ok: false, errors: { tripEnd: expect.stringContaining("366") as unknown } });
    expect(validateTripForm(form({ tripStart: "nope", timeZone: "UTC" }))).toMatchObject({
      ok: false,
    });
  });
});

describe("validateRateForm", () => {
  it("reads a day, a foreign currency and a rate (a comma decimal is fine)", () => {
    const result = validateRateForm(form({ day: "2026-11-03", currency: "EUR", rate: "1,5340" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.day).toBe("2026-11-03");
      expect(result.value.currency).toBe("EUR");
      expect(formatRate(result.value.rate)).toBe("1.534");
    }
  });

  it("refuses SGD, unknown currencies, bad days and bad rates", () => {
    expect(validateRateForm(form({ day: "2026-11-03", currency: "SGD", rate: "1" }))).toMatchObject(
      {
        ok: false,
        errors: { currency: "Pick a foreign currency" },
      },
    );
    expect(validateRateForm(form({ day: "x", currency: "XXX", rate: "0" }))).toMatchObject({
      ok: false,
      errors: { day: "Pick a valid date", currency: "Pick a foreign currency" },
    });
    expect(validateRateForm(form({ day: "2026-11-03", currency: "EUR", rate: "0" }))).toMatchObject(
      {
        ok: false,
        errors: { rate: expect.stringContaining("above zero") as unknown },
      },
    );
    expect(validateRateForm(form({ day: "2026-11-03", currency: "EUR", rate: "" }))).toMatchObject({
      ok: false,
      errors: { rate: "Enter a rate" },
    });
  });
});
