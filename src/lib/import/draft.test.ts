import { describe, expect, it } from "vitest";
import { transaction } from "@/test-support/extraction";
import {
  applyEdit,
  cleanBatch,
  draftEditSchema,
  rowToEdit,
  validateForConfirm,
  type DraftRow,
} from "./draft";
import { normalizeTransaction } from "./normalize";
import type { BatchSplit } from "./split";

const ORDER = ["a", "b", "c", "d"];
const BATCH: BatchSplit = { payerIds: ["a"], includePayers: false, mode: "equal", percents: null };

function draftRow(
  overrides: Parameters<typeof transaction>[0] = {},
  id = "r1",
  position = 0,
): DraftRow {
  return {
    ...normalizeTransaction(transaction(overrides), "2026-11-08"),
    id,
    position,
    duplicateOf: null,
    split: null,
  };
}

describe("rowToEdit", () => {
  it("shows a read amount as a plain number and an unread one as the text found", () => {
    expect(rowToEdit(draftRow()).amount).toBe("48.50");
    const unread = draftRow({ amount_text: "48,5,0,0", amount_value: null });
    expect(rowToEdit(unread).amount).toBe("48,5,0,0");
    expect(rowToEdit(unread).currency).toBe("EUR");
  });

  it("carries the billed amount and the row's own split", () => {
    const row = {
      ...draftRow({ billed_amount_text: "S$75.20", billed_currency: "SGD" }),
      split: { members: ["b"] },
    };
    expect(rowToEdit(row)).toMatchObject({
      billedAmount: "75.20",
      billedCurrency: "SGD",
      split: { members: ["b"] },
    });
  });
});

describe("applyEdit", () => {
  it("leaves a row alone when nothing changed, doubts included", () => {
    const row = draftRow({ amount_confidence: "likely" });
    const after = applyEdit(row, rowToEdit(row));
    expect(after.fieldStates).toEqual(row.fieldStates);
    expect(after.amountMinor).toBe(4850);
  });

  it("clears the doubt on a field a person changed", () => {
    const row = draftRow({ amount_confidence: "likely", merchant_confidence: "likely" });
    expect(row.fieldStates.amount).toBe("uncertain");
    const after = applyEdit(row, {
      ...rowToEdit(row),
      amount: "49.00",
      merchant: "Trattoria Bella",
    });
    expect(after.amountMinor).toBe(4900);
    expect(after.merchant).toBe("Trattoria Bella");
    expect(after.fieldStates.amount).toBe("clear");
    expect(after.fieldStates.merchant).toBe("clear");
    // The date was not touched.
    expect(after.fieldStates.date).toBe(row.fieldStates.date);
  });

  it("fills a missing field and marks one that is emptied or invalid as needing input", () => {
    const missing = draftRow({ date: null, merchant: null, amount_text: null, amount_value: null });
    const filled = applyEdit(missing, {
      ...rowToEdit(missing),
      date: "2026-11-04",
      merchant: "Louvre",
      amount: "64",
    });
    expect(filled).toMatchObject({ spentOn: "2026-11-04", merchant: "Louvre", amountMinor: 6400 });
    expect(Object.values(filled.fieldStates).every((s) => s === "clear")).toBe(true);

    const row = draftRow();
    const broken = applyEdit(row, {
      ...rowToEdit(row),
      amount: "abc",
      date: "2026-13-40",
      merchant: " ",
      currency: "",
    });
    expect(broken).toMatchObject({
      amountMinor: null,
      spentOn: null,
      merchant: null,
      currency: null,
    });
    expect(broken.fieldStates).toMatchObject({
      amount: "unreadable",
      date: "unreadable",
      merchant: "unreadable",
      currency: "unreadable",
    });
  });

  it("parses the amount in the chosen currency and rejects ambiguous text", () => {
    const row = draftRow();
    expect(applyEdit(row, { ...rowToEdit(row), currency: "CHF", amount: "10" })).toMatchObject({
      currency: "CHF",
      amountMinor: 1000,
    });
    expect(applyEdit(row, { ...rowToEdit(row), amount: "1.234" }).amountMinor).toBeNull();
    expect(applyEdit(row, { ...rowToEdit(row), amount: "0" }).amountMinor).toBeNull();
  });

  it("keeps a billed amount only when both parts read", () => {
    const row = draftRow();
    const withBilled = applyEdit(row, {
      ...rowToEdit(row),
      billedAmount: "75.20",
      billedCurrency: "SGD",
    });
    expect(withBilled).toMatchObject({
      billedAmountMinor: 7520,
      billedCurrency: "SGD",
      billedAmountText: "75.20",
    });
    expect(
      applyEdit(row, { ...rowToEdit(row), billedAmount: "75.20", billedCurrency: "" })
        .billedAmountMinor,
    ).toBeNull();
    expect(
      applyEdit(row, { ...rowToEdit(row), billedAmount: "oops", billedCurrency: "SGD" })
        .billedCurrency,
    ).toBeNull();
  });

  it("takes a valid category, ignores an unknown one, and keeps the checkbox and split", () => {
    const row = draftRow({ category: "food" });
    const changed = applyEdit(row, {
      ...rowToEdit(row),
      category: "stay",
      included: false,
      split: { members: ["c"] },
    });
    expect(changed).toMatchObject({ category: "stay", included: false, split: { members: ["c"] } });
    expect(changed.fieldStates.category).toBe("clear");
    expect(applyEdit(row, { ...rowToEdit(row), category: "nonsense" }).category).toBe("food");
  });

  it("shortens a very long merchant to the description limit", () => {
    const row = draftRow();
    expect(applyEdit(row, { ...rowToEdit(row), merchant: "x".repeat(200) }).merchant).toHaveLength(
      120,
    );
  });
});

describe("draftEditSchema", () => {
  it("accepts the shape the screen sends and rejects other shapes", () => {
    const row = rowToEdit(draftRow());
    expect(draftEditSchema.safeParse({ batch: BATCH, rows: [row] }).success).toBe(true);
    expect(
      draftEditSchema.safeParse({ batch: BATCH, rows: [{ ...row, included: "yes" }] }).success,
    ).toBe(false);
    expect(draftEditSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(
      draftEditSchema.safeParse({ batch: { ...BATCH, percents: { b: 20_000 } }, rows: [] }).success,
    ).toBe(false);
  });
});

describe("cleanBatch", () => {
  it("keeps payers to members in order and falls back to the uploader", () => {
    expect(cleanBatch({ ...BATCH, payerIds: ["c", "zzz", "a"] }, ORDER, "a").payerIds).toEqual([
      "a",
      "c",
    ]);
    expect(cleanBatch({ ...BATCH, payerIds: ["zzz"] }, ORDER, "b").payerIds).toEqual(["b"]);
    expect(cleanBatch({ ...BATCH, payerIds: [] }, ORDER, "d").payerIds).toEqual(["d"]);
  });

  it("drops percentages of people who are not members", () => {
    const batch = cleanBatch(
      { ...BATCH, mode: "percent", percents: { b: 5000, zzz: 5000 } },
      ORDER,
      "a",
    );
    expect(batch.percents).toEqual({ b: 5000 });
    expect(cleanBatch({ ...BATCH, percents: { zzz: 10_000 } }, ORDER, "a").percents).toBeNull();
  });
});

describe("validateForConfirm", () => {
  it("builds one valid expense per ticked row, paid by the payer and split among the rest", () => {
    const result = validateForConfirm(
      [draftRow(), draftRow({ merchant: "Metro" }, "r2", 1)],
      BATCH,
      ORDER,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.rows).toHaveLength(2);
    const [first] = result.rows;
    expect(first?.input).toMatchObject({
      description: "Trattoria Roma",
      category: "food",
      spentOn: "2026-11-03",
      amountMinor: 4850,
      currency: "EUR",
      splitMethod: "equal",
      billed: null,
      rate: null,
      payers: [{ userId: "a", amountMinor: 4850 }],
    });
    expect(first?.input.shares.map((s) => s.userId)).toEqual(["b", "c", "d"]);
    expect(first?.input.shares.reduce((s, x) => s + x.amountMinor, 0)).toBe(4850);
  });

  it("carries a billed amount into the expense and honours a row's own members", () => {
    const row = {
      ...draftRow({ billed_amount_text: "S$75.20", billed_currency: "SGD" }),
      split: { members: ["c", "d"] },
    };
    const result = validateForConfirm([row], BATCH, ORDER);
    if (!result.ok) throw new Error(result.message);
    expect(result.rows[0]?.input.billed).toEqual({ amountMinor: 7520, currency: "SGD" });
    expect(result.rows[0]?.input.shares.map((s) => s.userId)).toEqual(["c", "d"]);
  });

  it("uses percentages when a row switches to them", () => {
    const row = {
      ...draftRow(),
      split: { mode: "percent" as const, percents: { b: 7000, c: 3000 } },
    };
    const result = validateForConfirm([row], BATCH, ORDER);
    if (!result.ok) throw new Error(result.message);
    expect(result.rows[0]?.input.splitMethod).toBe("percent");
    expect(result.rows[0]?.input.shares).toEqual([
      { userId: "b", amountMinor: 3395, weight: 7000 },
      { userId: "c", amountMinor: 1455, weight: 3000 },
    ]);
  });

  it("does not look at rows that are unchecked", () => {
    const unreadable = { ...draftRow({ date: null }, "r2", 1), included: false };
    const result = validateForConfirm([draftRow(), unreadable], BATCH, ORDER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(1);
  });

  it("needs at least one ticked row", () => {
    expect(validateForConfirm([{ ...draftRow(), included: false }], BATCH, ORDER)).toEqual({
      ok: false,
      message: "Tick at least one row to add",
      errors: {},
    });
    expect(validateForConfirm([], BATCH, ORDER).ok).toBe(false);
  });

  it("reports what is missing on each ticked row", () => {
    const missing = {
      ...draftRow({ date: null, merchant: null, currency: null, amount_text: null }, "r2", 1),
      included: true,
    };
    const result = validateForConfirm([draftRow(), missing], BATCH, ORDER);
    if (result.ok) throw new Error("expected errors");
    expect(result.message).toBe("One row needs attention before it can be added");
    expect(result.errors.r2).toMatchObject({
      merchant: "Add a description",
      date: "Pick a valid date",
      currency: "Pick the currency",
      amount: "Enter an amount like 48.50",
    });
    expect(result.errors.r1).toBeUndefined();
  });

  it("reports a split that does not work", () => {
    const row = { ...draftRow(), split: { members: [] } };
    const bad = {
      ...draftRow({}, "r2", 1),
      split: { mode: "percent" as const, percents: { b: 5000, c: 4000 } },
    };
    const result = validateForConfirm([row, bad], BATCH, ORDER);
    if (result.ok) throw new Error("expected errors");
    expect(result.message).toBe("2 rows need attention before they can be added");
    expect(result.errors.r1?.split).toBe("Pick at least one person to share this with");
    expect(result.errors.r2?.split).toBe("Percentages add up to 90.00%, not 100%");
  });

  it("catches a row still marked as needing input even if its fields look filled", () => {
    const stuck: DraftRow = {
      ...draftRow(),
      fieldStates: { ...draftRow().fieldStates, category: "unreadable" },
    };
    const result = validateForConfirm([stuck], BATCH, ORDER);
    if (result.ok) throw new Error("expected errors");
    expect(result.errors.r1?.form).toBe("Fill in the missing details");
  });
});
