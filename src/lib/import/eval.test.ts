import { describe, expect, it } from "vitest";
import { transaction, wireframeExtraction } from "@/test-support/extraction";
import { normalizeExtraction, normalizeTransaction } from "./normalize";
import { goldenSchema, scoreImage, summarize, type Golden } from "./eval";

const TODAY = "2026-11-08";

const golden: Golden = {
  transactions: [
    {
      merchant: "Trattoria Roma",
      date: "2026-11-03",
      amount: "48.50",
      currency: "EUR",
      category: "food",
    },
    {
      merchant: "Metro Roma",
      date: "2026-11-03",
      amount: "12.00",
      currency: "EUR",
      category: "transport",
    },
    {
      merchant: "AMZN Mktp",
      date: "2026-11-03",
      amount: "23.99",
      currency: "EUR",
      category: "shopping",
    },
    {
      merchant: "Louvre",
      date: "2026-11-04",
      amount: "64.00",
      currency: "EUR",
      category: "sightseeing",
    },
  ],
};

describe("goldenSchema", () => {
  it("accepts the documented shape and rejects others", () => {
    expect(goldenSchema.safeParse(golden).success).toBe(true);
    expect(goldenSchema.safeParse({ transactions: [{ merchant: "x" }] }).success).toBe(false);
    expect(
      goldenSchema.safeParse({ transactions: [{ ...golden.transactions[0], category: "weapons" }] })
        .success,
    ).toBe(false);
  });
});

describe("scoreImage", () => {
  it("scores a perfect reading at 100% with no silent errors", () => {
    const rows = normalizeExtraction(wireframeExtraction(), TODAY).rows;
    const summary = summarize([scoreImage(golden, rows)]);
    expect(summary.overall).toBe(100);
    expect(summary).toMatchObject({ images: 1, goldenRows: 4, missed: 0, extra: 0 });
    expect(
      Object.values(summary.fields).every((f) => f.accuracy === 100 && f.silentErrors === 0),
    ).toBe(true);
  });

  it("counts a wrong field, and calls it silent only when the screen would not have flagged it", () => {
    const rows = [
      // Wrong category, but flagged as a check (confidence 60): not a silent error.
      normalizeTransaction(transaction({ category: "other", category_confidence: 60 }), TODAY),
      // Wrong merchant with full confidence: silent.
      normalizeTransaction(
        transaction({ merchant: "Pizzeria Napoli", amount_text: "€12,00", amount_value: "12.00" }),
        TODAY,
      ),
    ];
    const score = scoreImage({ transactions: golden.transactions.slice(0, 2) }, rows);
    // The second row has the wrong category (food, not transport) with full confidence: silent.
    expect(score.fields.category).toEqual({ correct: 0, total: 2, silentErrors: 1 });
    expect(score.fields.merchant).toEqual({ correct: 1, total: 2, silentErrors: 1 });
    expect(score.fields.amount).toEqual({ correct: 2, total: 2, silentErrors: 0 });
  });

  it("counts missed and extra rows", () => {
    const rows = normalizeExtraction(wireframeExtraction(), TODAY).rows;
    const missed = scoreImage(golden, rows.slice(0, 2));
    expect(missed).toMatchObject({ goldenRows: 4, readRows: 2, missed: 2, extra: 0 });
    expect(missed.fields.amount).toEqual({ correct: 2, total: 4, silentErrors: 0 });
    const extra = scoreImage({ transactions: golden.transactions.slice(0, 1) }, rows);
    expect(extra).toMatchObject({ missed: 0, extra: 3 });
  });

  it("checks billed amounts both ways and pairs rows by amount when the order differs", () => {
    const billedGolden: Golden = {
      transactions: [
        { ...golden.transactions[0]!, billedAmount: "75.20", billedCurrency: "SGD" },
        golden.transactions[1]!,
      ],
    };
    const rows = [
      normalizeTransaction(
        transaction({ merchant: "Metro Roma", amount_text: "€12,00", amount_value: "12.00" }),
        TODAY,
      ),
      normalizeTransaction(
        transaction({ billed_amount_text: "S$75.20", billed_currency: "SGD" }),
        TODAY,
      ),
    ];
    const score = scoreImage(billedGolden, rows);
    expect(score.fields.billed).toEqual({ correct: 2, total: 2, silentErrors: 0 });
    const without = scoreImage(billedGolden, [
      normalizeTransaction(transaction(), TODAY),
      rows[0]!,
    ]);
    expect(without.fields.billed.correct).toBe(1);
  });

  it("treats an unparsable golden amount as never matching", () => {
    const odd: Golden = { transactions: [{ ...golden.transactions[0]!, amount: "lots" }] };
    expect(
      scoreImage(odd, [normalizeTransaction(transaction(), TODAY)]).fields.amount.correct,
    ).toBe(0);
    const badCurrency: Golden = { transactions: [{ ...golden.transactions[0]!, currency: "XYZ" }] };
    expect(
      scoreImage(badCurrency, [normalizeTransaction(transaction(), TODAY)]).fields.currency.correct,
    ).toBe(0);
  });
});

describe("summarize", () => {
  it("adds images up and rounds accuracy half up to whole percent", () => {
    const rows = normalizeExtraction(wireframeExtraction(), TODAY).rows;
    const good = scoreImage(golden, rows);
    const bad = scoreImage(golden, []);
    const summary = summarize([good, bad]);
    expect(summary.images).toBe(2);
    expect(summary.overall).toBe(50);
    expect(summary.fields.amount).toMatchObject({ correct: 4, total: 8, accuracy: 50 });
    expect(summary.missed).toBe(4);
    expect(summarize([]).overall).toBe(100);
    const third = scoreImage({ transactions: golden.transactions.slice(0, 3) }, rows.slice(0, 2));
    expect(summarize([third]).fields.amount.accuracy).toBe(67);
  });
});
