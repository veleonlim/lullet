import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertIsoDate, isIsoDate } from "./dates";

describe("iso dates", () => {
  it.each(["2026-11-07", "2024-02-29", "2000-01-01"])("accepts %s", (value) => {
    expect(isIsoDate(value)).toBe(true);
    expect(assertIsoDate(value)).toBe(value);
  });

  it.each([
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-00-10",
    "26-11-07",
    "2026-1-7",
    "",
    "2026-11-07T00:00",
  ])("rejects %j", (value) => {
    expect(isIsoDate(value)).toBe(false);
    expect(() => assertIsoDate(value)).toThrow(RangeError);
  });

  it("rejects non strings", () => {
    expect(isIsoDate(20261107)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });

  it("accepts every date produced by Date.toISOString", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("1990-01-01T00:00:00Z"),
          max: new Date("2100-01-01T00:00:00Z"),
          noInvalidDate: true,
        }),
        (date) => isIsoDate(date.toISOString().slice(0, 10)),
      ),
    );
  });
});
