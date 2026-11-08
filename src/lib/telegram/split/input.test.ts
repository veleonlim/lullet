import { describe, expect, it } from "vitest";
import {
  readAmount,
  readAmountList,
  readCategory,
  readDay,
  readPercentList,
  readTitle,
  shiftDay,
} from "./input";

const ok = <T>(result: { ok: boolean; value?: T; message?: string }): T => {
  if (!result.ok) throw new Error(result.message);
  return result.value as T;
};
const message = (result: { ok: boolean; message?: string }): string => {
  if (result.ok) throw new Error("expected a failure");
  return result.message ?? "";
};

describe("the title", () => {
  it("trims and collapses spaces", () => {
    expect(ok(readTitle("  Dinner   at  Luigi's \n"))).toBe("Dinner at Luigi's");
  });
  it("refuses an empty or very long title", () => {
    expect(message(readTitle("   "))).toContain("what the expense was for");
    expect(message(readTitle("x".repeat(121)))).toContain("120");
    expect(ok(readTitle("x".repeat(120)))).toHaveLength(120);
  });
});

describe("the amount", () => {
  it("reads a bare number in the default currency", () => {
    expect(ok(readAmount("45", "SGD"))).toEqual({ minor: 4500, currency: "SGD" });
    expect(ok(readAmount("45.50", "EUR"))).toEqual({ minor: 4550, currency: "EUR" });
    expect(ok(readAmount("12,50", "CHF"))).toEqual({ minor: 1250, currency: "CHF" });
  });

  it("reads a written currency over the default", () => {
    expect(ok(readAmount("100 EUR", "SGD"))).toEqual({ minor: 10000, currency: "EUR" });
    expect(ok(readAmount("eur 100", "SGD"))).toEqual({ minor: 10000, currency: "EUR" });
    expect(ok(readAmount("S$45", "EUR"))).toEqual({ minor: 4500, currency: "SGD" });
    expect(ok(readAmount("€12.50", "SGD"))).toEqual({ minor: 1250, currency: "EUR" });
    expect(ok(readAmount("1,234.50 CHF", "SGD"))).toEqual({ minor: 123450, currency: "CHF" });
  });

  it("reads a bare dollar sign only as SGD or USD", () => {
    expect(ok(readAmount("$45", "SGD"))).toEqual({ minor: 4500, currency: "SGD" });
    expect(message(readAmount("$45", "EUR"))).toContain("Which currency");
  });

  it("refuses what is not one clear amount, and says how to write it", () => {
    expect(message(readAmount("dinner", "SGD"))).toContain("Try 45, S$45 or 100 EUR");
    expect(message(readAmount("", "SGD"))).toContain("not an amount");
    expect(message(readAmount("0", "SGD"))).toContain("more than zero");
    expect(message(readAmount("-5", "SGD"))).toContain("more than zero");
    expect(message(readAmount("45 XYZ", "SGD"))).toContain("do not know that currency");
    expect(message(readAmount("1.234", "SGD"))).toContain("Unclear amount");
    expect(message(readAmount("10.123", "SGD"))).toContain("decimal");
    expect(message(readAmount("9999999999999999999", "SGD"))).toContain("too large");
  });
});

describe("a list of amounts", () => {
  const ids = ["a", "b"];
  it("reads one amount per person", () => {
    expect(ok(readAmountList("60 40", ids, "EUR", 10000))).toEqual({ a: 6000, b: 4000 });
    expect(ok(readAmountList("60/40", ids, "EUR", 10000))).toEqual({ a: 6000, b: 4000 });
    expect(ok(readAmountList("12,50; 7.5", ids, "EUR", 2000))).toEqual({ a: 1250, b: 750 });
    expect(ok(readAmountList("12, 8", ids, "EUR", 2000))).toEqual({ a: 1200, b: 800 });
  });
  it("gives the last person the rest when their amount is left out", () => {
    expect(ok(readAmountList("60", ids, "EUR", 10000))).toEqual({ a: 6000, b: 4000 });
    expect(message(readAmountList("100", ids, "EUR", 10000))).toContain("already add up");
  });
  it("refuses the wrong count or a bad amount", () => {
    expect(message(readAmountList("1 2 3", ids, "EUR", 10000))).toContain("Send 2 amounts");
    expect(message(readAmountList("", ids, "EUR", 10000))).toContain("one amount per person");
    expect(message(readAmountList("60 abc", ids, "EUR", 10000))).toContain('"abc"');
    expect(message(readAmountList("60 0", ids, "EUR", 10000))).toContain("more than zero");
  });
});

describe("a list of percentages", () => {
  it("reads basis points and lets the last person take the rest", () => {
    expect(ok(readPercentList("60 40", ["a", "b"]))).toEqual({ a: 6000, b: 4000 });
    expect(ok(readPercentList("60%", ["a", "b"]))).toEqual({ a: 6000, b: 4000 });
    expect(ok(readPercentList("33.33 33.33 33.34", ["a", "b", "c"]))).toEqual({
      a: 3333,
      b: 3333,
      c: 3334,
    });
  });
  it("refuses anything that is not 100% or gives someone nothing", () => {
    expect(message(readPercentList("60 30", ["a", "b"]))).toContain("add up to 100");
    expect(message(readPercentList("100 0", ["a", "b"]))).toContain("more than 0%");
    expect(message(readPercentList("hello", ["a", "b"]))).toContain("percentages");
    expect(message(readPercentList("50 25 25", ["a", "b"]))).toContain("Send 2 percentages");
  });
});

describe("the date", () => {
  const today = "2026-11-08";
  it("reads today, yesterday and ISO dates", () => {
    expect(ok(readDay("today", today))).toBe("2026-11-08");
    expect(ok(readDay("Yesterday", today))).toBe("2026-11-07");
    expect(ok(readDay("2026-11-02", today))).toBe("2026-11-02");
    expect(ok(readDay("2026-1-2", today))).toBe("2026-01-02");
  });
  it("reads day before month, with or without a year", () => {
    expect(ok(readDay("8/11", today))).toBe("2026-11-08");
    expect(ok(readDay("2.11", today))).toBe("2026-11-02");
    expect(ok(readDay("8/11/2025", today))).toBe("2025-11-08");
    expect(ok(readDay("31-12", today))).toBe("2026-12-31");
  });
  it("reads month names", () => {
    expect(ok(readDay("8 Nov", today))).toBe("2026-11-08");
    expect(ok(readDay("8th november 2025", today))).toBe("2025-11-08");
    expect(ok(readDay("Nov 8", today))).toBe("2026-11-08");
    expect(ok(readDay("Sept 3", today))).toBe("2026-09-03");
  });
  it("refuses impossible or unreadable dates", () => {
    for (const text of [
      "31/2",
      "2026-02-30",
      "32 Nov",
      "hello",
      "8 Foo",
      "13/13",
      "1999-01-01",
      "",
    ]) {
      expect(message(readDay(text, today))).toContain("could not read that date");
    }
  });
  it("shifts a calendar day across month and year ends", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
  });
});

describe("the category", () => {
  it("reads a category by name in any case", () => {
    expect(ok(readCategory("transport"))).toBe("transport");
    expect(ok(readCategory(" Sightseeing "))).toBe("sightseeing");
  });
  it("lists the choices when the name is unknown", () => {
    expect(message(readCategory("fun"))).toContain("Food, Transport");
  });
});
