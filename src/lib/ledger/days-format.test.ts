import { describe, expect, it } from "vitest";
import { CATEGORIES, categoryLabel, CATEGORY_IDS, isCategoryId } from "./categories";
import { formatDate, formatDay, groupByDay, todayIn } from "./days";
import { formatBasisPoints, formatMoney, formatPlainAmount } from "./format";
import { expenseCategory } from "@/db/schema";

describe("formatMoney", () => {
  it.each([
    [4850, "EUR", "€48.50"],
    [4850, "CHF", "CHF 48.50"],
    [123456, "SGD", "S$1,234.56"],
    [-500, "EUR", "-€5.00"],
    [0, "SGD", "S$0.00"],
    [1500, "JPY", "¥1,500"],
    [5, "USD", "US$0.05"],
  ] as const)("%d %s is %s", (minor, currency, text) => {
    expect(formatMoney(minor, currency)).toBe(text);
  });

  it("can show a plus sign for balances", () => {
    expect(formatMoney(500, "SGD", { signed: true })).toBe("+S$5.00");
    expect(formatMoney(-500, "SGD", { signed: true })).toBe("-S$5.00");
    expect(formatMoney(0, "SGD", { signed: true })).toBe("S$0.00");
  });

  it("formats input values and percentages", () => {
    expect(formatPlainAmount(123456, "EUR")).toBe("1234.56");
    expect(formatPlainAmount(1500, "JPY")).toBe("1500");
    expect(formatBasisPoints(3333)).toBe("33.33");
    expect(formatBasisPoints(5000)).toBe("50");
    expect(formatBasisPoints(750)).toBe("7.5");
    expect(formatBasisPoints(10000)).toBe("100");
  });
});

describe("days", () => {
  it("labels days without shifting them across time zones", () => {
    expect(formatDay("2026-11-07")).toBe("Sat 7 Nov");
    expect(formatDay("2026-01-01", 2026)).toBe("Thu 1 Jan");
    expect(formatDay("2025-12-31", 2026)).toBe("Wed 31 Dec 2025");
    expect(formatDate("2026-11-07")).toBe("7 Nov 2026");
  });

  it("rejects impossible dates", () => {
    expect(() => formatDay("2026-02-30")).toThrow(RangeError);
  });

  it("finds today in a time zone", () => {
    const instant = new Date("2026-11-07T23:30:00Z");
    expect(todayIn(instant)).toBe("2026-11-07");
    expect(todayIn(instant, "Asia/Singapore")).toBe("2026-11-08");
    expect(todayIn(instant, "America/Los_Angeles")).toBe("2026-11-07");
  });

  it("groups by day, newest day first, keeping the order within a day", () => {
    const items = [
      { id: 1, day: "2026-11-02" },
      { id: 2, day: "2026-11-05" },
      { id: 3, day: "2026-11-02" },
      { id: 4, day: "2026-11-05" },
      { id: 5, day: "2026-11-03" },
    ];
    const groups = groupByDay(items, (item) => item.day);
    expect(groups.map((g) => g.date)).toEqual(["2026-11-05", "2026-11-03", "2026-11-02"]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([[2, 4], [5], [1, 3]]);
    expect(groupByDay([], (item: { day: string }) => item.day)).toEqual([]);
  });
});

describe("categories", () => {
  it("match the database enum exactly, in order", () => {
    expect([...CATEGORY_IDS]).toEqual(expenseCategory.enumValues);
  });

  it("have labels and a type guard", () => {
    expect(CATEGORIES).toHaveLength(6);
    expect(categoryLabel("sightseeing")).toBe("Sightseeing");
    expect(categoryLabel("nope" as never)).toBe("Other");
    expect(isCategoryId("food")).toBe(true);
    expect(isCategoryId("fod")).toBe(false);
  });
});
