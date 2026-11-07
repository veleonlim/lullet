import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sum } from "@/lib/money";
import {
  evenBasisPoints,
  isSplitMode,
  previewShares,
  readBasisPoints,
  validateExpenseForm,
  type ExpenseFormValues,
} from "./expense-form";
import { blankExpenseForm, expenseToFormValues } from "./form-values";
import type { Member, StoredExpense } from "./types";

const members: Member[] = ["a", "b", "c", "d"].map((userId, position) => ({
  userId,
  displayName: userId.toUpperCase(),
  position,
}));
const order = members.map((m) => m.userId);

function form(overrides: Partial<ExpenseFormValues> = {}): ExpenseFormValues {
  return {
    ...blankExpenseForm({ members, payerUserId: "a", today: "2026-11-02" }),
    description: "Trattoria",
    amount: "148.49",
    ...overrides,
  };
}

function ok(values: ExpenseFormValues) {
  const result = validateExpenseForm(values, order);
  if (!result.ok) throw new Error(`expected valid, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

function errorsOf(values: unknown) {
  const result = validateExpenseForm(values, order);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("validateExpenseForm", () => {
  it("splits the report example equally with the spare cent by member order", () => {
    const value = ok(form());
    expect(value.amountMinor).toBe(14849);
    expect(value.payers).toEqual([{ userId: "a", amountMinor: 14849 }]);
    expect(value.shares.map((s) => s.amountMinor)).toEqual([3713, 3712, 3712, 3712]);
    expect(value.splitMethod).toBe("equal");
    expect(value.billed).toBeNull();
    expect(value.rate).toBeNull();
  });

  it("accepts a comma decimal and trims the description", () => {
    const value = ok(form({ description: "  Metro  ", amount: "12,00" }));
    expect(value.description).toBe("Metro");
    expect(value.amountMinor).toBe(1200);
  });

  it("splits only among the included members", () => {
    const base = form();
    const value = ok({
      ...base,
      split: {
        mode: "equal",
        members: base.split.members.map((m) => ({ ...m, included: m.userId !== "b" })),
      },
    });
    expect(value.shares.map((s) => s.userId)).toEqual(["a", "c", "d"]);
    expect(sum(value.shares.map((s) => s.amountMinor))).toBe(14849);
  });

  describe("amount", () => {
    it.each([
      ["", "Enter an amount"],
      ["abc", "Type just the number, e.g. 48.50"],
      ["12 x 3", "Enter an amount like 48.50"],
      ["0", "The amount must be more than zero"],
      ["-5", "The amount must be more than zero"],
      ["1.234", "Unclear amount: type the decimals, e.g. 1234.00 or 1.23"],
      ["1.2345", "Too many decimal places for this currency"],
      ["99999999999999999999", "That amount is too large"],
      ["CHF 12.00", "Type just the number; the currency has its own field"],
    ])("rejects %j", (amount, message) => {
      expect(errorsOf(form({ amount })).amount).toBe(message);
    });

    it("reads zero decimal currencies as whole units", () => {
      const value = ok(form({ currency: "JPY", amount: "1500" }));
      expect(value.amountMinor).toBe(1500);
      expect(errorsOf(form({ currency: "JPY", amount: "15.5" })).amount).toBe(
        "Too many decimal places for this currency",
      );
    });
  });

  describe("shape", () => {
    it("rejects a bad description, date, category and currency", () => {
      const errors = errorsOf(
        form({
          description: "   ",
          spentOn: "2026-02-30",
          category: "x",
          currency: "XXX",
        }),
      );
      expect(errors.description).toBe("Add a description");
      expect(errors.spentOn).toBe("Pick a valid date");
      expect(errors.category).toBe("Pick a category");
      expect(errors.currency).toBe("Pick a supported currency");
    });

    it("rejects a very long description", () => {
      expect(errorsOf(form({ description: "x".repeat(121) })).description).toMatch(/under 120/);
    });

    it("does not trust the payload shape", () => {
      expect(errorsOf(null).form).toMatch(/not understood/);
      expect(errorsOf({ ...form(), payers: "nope" }).form).toMatch(/not understood/);
    });
  });

  describe("billed amount and own rate", () => {
    it("reads a billed amount in another currency and a matching rate", () => {
      const value = ok(
        form({
          currency: "EUR",
          billed: { amount: "230.10", currency: "CHF" },
          rate: { rate: "1,5340", currency: "CHF" },
        }),
      );
      expect(value.billed).toEqual({ amountMinor: 23010, currency: "CHF" });
      expect(value.rate?.currency).toBe("CHF");
    });

    it("treats an opened but empty section as absent", () => {
      const value = ok(
        form({ billed: { amount: " ", currency: "" }, rate: { rate: "", currency: "" } }),
      );
      expect(value.billed).toBeNull();
      expect(value.rate).toBeNull();
    });

    it("flags a billed amount without a usable currency or amount", () => {
      expect(errorsOf(form({ billed: { amount: "5", currency: "" } }))["billed.currency"]).toBe(
        "Pick the billed currency",
      );
      expect(errorsOf(form({ billed: { amount: "x", currency: "SGD" } }))["billed.amount"]).toBe(
        "Enter an amount like 48.50",
      );
    });

    it("refuses a rate that would be ignored", () => {
      const errors = (rate: ExpenseFormValues["rate"], extra: Partial<ExpenseFormValues> = {}) =>
        errorsOf(form({ rate, ...extra }));
      expect(errors({ rate: "1.5", currency: "CHF" })["rate.currency"]).toBe(
        "The amount is in EUR, so the rate must be for EUR",
      );
      expect(
        errors({ rate: "1.5", currency: "EUR" }, { billed: { amount: "10", currency: "CHF" } })[
          "rate.currency"
        ],
      ).toBe("The bank billed in CHF, so the rate must be for CHF");
      expect(errors({ rate: "1.5", currency: "EUR" }, { currency: "SGD" })["rate.rate"]).toBe(
        "Not needed: this is already in SGD",
      );
      expect(
        errors({ rate: "1.5", currency: "EUR" }, { billed: { amount: "10", currency: "SGD" } })[
          "rate.rate"
        ],
      ).toBe("Not needed: this is already in SGD");
      expect(errors({ rate: "1.5", currency: "SGD" })["rate.currency"]).toBe(
        "Rates are SGD per 1 unit of a foreign currency",
      );
      expect(errors({ rate: "1.5", currency: "" })["rate.currency"]).toBe(
        "Pick the currency this rate is for",
      );
    });

    it.each(["abc", "0", "-1", "1.12345678901", "1,2,3"])("rejects the rate %j", (rate) => {
      expect(errorsOf(form({ rate: { rate, currency: "EUR" } }))["rate.rate"]).toMatch(/rate/i);
    });

    it("ignores a rate section that was opened but left blank", () => {
      const value = ok(form({ rate: { rate: "  ", currency: "EUR" } }));
      expect(value.rate).toBeNull();
    });
  });

  describe("payers", () => {
    const payers = (rows: [string, boolean, string][]): ExpenseFormValues["payers"] =>
      rows.map(([userId, included, amount]) => ({ userId, included, amount }));

    it("requires at least one payer", () => {
      expect(errorsOf(form({ payers: payers([["a", false, ""]]) })).payers).toBe("Pick who paid");
    });

    it("gives a single payer the whole amount whatever is typed", () => {
      const value = ok(form({ payers: payers([["b", true, "1"]]) }));
      expect(value.payers).toEqual([{ userId: "b", amountMinor: 14849 }]);
    });

    it("accepts several payers that add up exactly, in member order", () => {
      const value = ok(
        form({
          payers: payers([
            ["c", true, "48.49"],
            ["a", true, "100.00"],
          ]),
        }),
      );
      expect(value.payers).toEqual([
        { userId: "a", amountMinor: 10000 },
        { userId: "c", amountMinor: 4849 },
      ]);
    });

    it("rejects payments that do not add up, naming both totals", () => {
      const errors = errorsOf(
        form({
          payers: payers([
            ["a", true, "100.00"],
            ["b", true, "48.48"],
          ]),
        }),
      );
      expect(errors.payers).toBe("Payments add up to €148.48, but the expense is €148.49");
    });

    it("reports each unreadable payer amount", () => {
      const errors = errorsOf(
        form({
          payers: payers([
            ["a", true, ""],
            ["b", true, "0"],
          ]),
        }),
      );
      expect(errors["payers.a"]).toBe("Enter an amount");
      expect(errors["payers.b"]).toBe("The amount must be more than zero");
    });

    it("rejects unknown or repeated payers", () => {
      expect(errorsOf(form({ payers: payers([["zed", true, ""]]) })).payers).toMatch(
        /not in this group/,
      );
      expect(
        errorsOf(
          form({
            payers: payers([
              ["a", true, "1"],
              ["a", true, "2"],
            ]),
          }),
        ).payers,
      ).toMatch(/not in this group/);
    });
  });

  describe("split modes", () => {
    const withSplit = (mode: ExpenseFormValues["split"]["mode"], values: Record<string, string>) =>
      form({
        split: {
          mode,
          members: order.map((userId) => ({
            userId,
            included: userId in values,
            value: values[userId] ?? "",
          })),
        },
      });

    it("exact: amounts must add up to the expense", () => {
      const value = ok(withSplit("exact", { a: "100", b: "48.49" }));
      expect(value.shares).toEqual([
        { userId: "a", amountMinor: 10000, weight: null },
        { userId: "b", amountMinor: 4849, weight: null },
      ]);
      expect(errorsOf(withSplit("exact", { a: "100", b: "48" })).split).toBe(
        "Amounts add up to €148.00, but the expense is €148.49",
      );
      expect(errorsOf(withSplit("exact", { a: "", b: "48" }))["split.a"]).toBe("Enter an amount");
    });

    it("percent: must total exactly 100% and keeps the basis points", () => {
      const value = ok(withSplit("percent", { a: "33.34", b: "33.33", c: "33.33" }));
      expect(value.shares.map((s) => s.weight)).toEqual([3334, 3333, 3333]);
      expect(sum(value.shares.map((s) => s.amountMinor))).toBe(14849);
      expect(errorsOf(withSplit("percent", { a: "50", b: "49.99" })).split).toBe(
        "Percentages add up to 99.99%, not 100%",
      );
      expect(errorsOf(withSplit("percent", { a: "abc", b: "50" }))["split.a"]).toBe(
        "Enter a percentage like 33.33",
      );
      expect(errorsOf(withSplit("percent", { a: "0", b: "100" }))["split.a"]).toBe(
        "Enter a percentage like 33.33",
      );
    });

    it("shares: proportional, whole numbers only", () => {
      const value = ok(withSplit("shares", { a: "2", b: "1", c: "1" }));
      expect(value.shares.map((s) => s.amountMinor)).toEqual([7425, 3712, 3712]);
      expect(value.shares.map((s) => s.weight)).toEqual([2, 1, 1]);
      expect(errorsOf(withSplit("shares", { a: "1.5" }))["split.a"]).toBe(
        "Enter a whole number from 1 to 1000",
      );
      expect(errorsOf(withSplit("shares", { a: "0" }))["split.a"]).toBe(
        "Enter a whole number from 1 to 1000",
      );
    });

    it("needs at least one person, and only group members", () => {
      expect(errorsOf(withSplit("equal", {})).split).toBe(
        "Pick at least one person to share this with",
      );
      const base = form();
      expect(
        errorsOf({
          ...base,
          split: { mode: "equal", members: [{ userId: "zed", included: true, value: "" }] },
        }).split,
      ).toMatch(/not in this group/);
    });

    it("previews shares only while the split is complete", () => {
      const base = form();
      expect(previewShares(base.split, 14849, "EUR", order)?.map((s) => s.amountMinor)).toEqual([
        3713, 3712, 3712, 3712,
      ]);
      const broken = withSplit("exact", { a: "1" });
      expect(previewShares(broken.split, 14849, "EUR", order)).toBeUndefined();
    });
  });

  it("property: payers and shares always add up to the amount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.subarray(order, { minLength: 1 }),
        fc.constantFrom("equal" as const),
        (amountMinor, included, mode) => {
          const base = form({ amount: (amountMinor / 100).toFixed(2) });
          const value = ok({
            ...base,
            split: {
              mode,
              members: base.split.members.map((m) => ({
                ...m,
                included: included.includes(m.userId),
              })),
            },
          });
          expect(sum(value.shares.map((s) => s.amountMinor))).toBe(value.amountMinor);
          expect(sum(value.payers.map((p) => p.amountMinor))).toBe(value.amountMinor);
        },
      ),
    );
  });
});

describe("expenseToFormValues", () => {
  const stored = (overrides: Partial<StoredExpense>): StoredExpense => ({
    id: "e1",
    description: "Hotel",
    category: "stay",
    spentOn: "2026-11-03",
    amountMinor: 30000,
    currency: "CHF",
    billedAmountMinor: 51000,
    billedCurrency: "SGD",
    rate: "1.6000000000",
    rateCurrency: "CHF",
    splitMethod: "percent",
    payers: [
      { userId: "a", amountMinor: 10000 },
      { userId: "b", amountMinor: 20000 },
    ],
    shares: [
      { userId: "a", amountMinor: 15000, weight: 5000 },
      { userId: "c", amountMinor: 15000, weight: 5000 },
    ],
    createdBy: "a",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  });

  it.each(["equal", "exact", "percent", "shares"] as const)(
    "round trips a %s split through the form",
    (splitMethod) => {
      const weight = splitMethod === "percent" ? 5000 : splitMethod === "shares" ? 1 : null;
      const expense = stored({
        splitMethod,
        billedAmountMinor: null,
        billedCurrency: null,
        rate: null,
        rateCurrency: null,
        shares: [
          { userId: "a", amountMinor: 15000, weight },
          { userId: "c", amountMinor: 15000, weight },
        ],
      });
      const values = expenseToFormValues(expense, members);
      const result = ok(values);
      expect(result.splitMethod).toBe(splitMethod);
      expect(result.payers).toEqual(expense.payers);
      expect(result.shares).toEqual(expense.shares);
    },
  );

  it("keeps billed amount and rate", () => {
    const values = expenseToFormValues(stored({}), members);
    expect(values.billed).toEqual({ amount: "510.00", currency: "SGD" });
    // A rate for CHF is pointless once the bank billed SGD, and validation says so.
    expect(errorsOf(values)["rate.rate"]).toBe("Not needed: this is already in SGD");
    const withoutBilled = expenseToFormValues(
      stored({ billedAmountMinor: null, billedCurrency: null }),
      members,
    );
    expect(withoutBilled.rate).toEqual({ rate: "1.6", currency: "CHF" });
    expect(ok(withoutBilled).rate?.currency).toBe("CHF");
  });
});

describe("helpers", () => {
  it("reads percentages into basis points", () => {
    expect(readBasisPoints("33.33")).toBe(3333);
    expect(readBasisPoints("50")).toBe(5000);
    expect(readBasisPoints("7,5")).toBe(750);
    expect(readBasisPoints("100")).toBe(10000);
    expect(readBasisPoints("33.333")).toBeUndefined();
    expect(readBasisPoints("")).toBeUndefined();
  });

  it("evens out basis points so they total 100%", () => {
    expect(evenBasisPoints(3)).toEqual([3334, 3333, 3333]);
    expect(evenBasisPoints(4)).toEqual([2500, 2500, 2500, 2500]);
    expect(sum(evenBasisPoints(7))).toBe(10000);
  });

  it("recognises split modes", () => {
    expect(isSplitMode("percent")).toBe(true);
    expect(isSplitMode("weights")).toBe(false);
  });
});
