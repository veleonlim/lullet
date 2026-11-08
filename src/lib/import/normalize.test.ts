import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extraction, transaction, wireframeExtraction } from "@/test-support/extraction";
import {
  isBlocking,
  normalizeExtraction,
  normalizeTransaction,
  rowState,
  worseState,
} from "./normalize";

const TODAY = "2026-11-08";
const row = (overrides: Parameters<typeof transaction>[0] = {}) =>
  normalizeTransaction(transaction(overrides), TODAY);

describe("a clean transaction", () => {
  it("is read in integer minor units with every field clear", () => {
    const seed = row();
    expect(seed).toMatchObject({
      merchant: "Trattoria Roma",
      spentOn: "2026-11-03",
      amountMinor: 4850,
      currency: "EUR",
      billedAmountMinor: null,
      category: "food",
      included: true,
      issues: [],
    });
    expect(Object.values(seed.fieldStates).every((state) => state === "clear")).toBe(true);
    expect(rowState(seed.fieldStates)).toBe("clear");
    expect(isBlocking(seed.fieldStates)).toBe(false);
  });

  it("reads the wireframe batch as 4 rows adding to 148.49", () => {
    const result = normalizeExtraction(wireframeExtraction(), TODAY);
    expect(result.rows.map((r) => r.amountMinor)).toEqual([4850, 1200, 2399, 6400]);
    expect(result.rows.reduce((sum, r) => sum + (r.amountMinor ?? 0), 0)).toBe(14849);
    expect(result.screenTotal).toEqual({ text: "€148,49", minor: 14849, currency: "EUR" });
    // The AMZN row is a "check": amount likely, category 60.
    const amzn = result.rows[2];
    expect(amzn?.fieldStates.amount).toBe("uncertain");
    expect(amzn?.fieldStates.category).toBe("uncertain");
    expect(amzn?.included).toBe(true);
  });
});

describe("amounts are re-read from the text shown", () => {
  it("flags a disagreement with the model's own reading and keeps our reading", () => {
    const seed = row({ amount_text: "€48,50", amount_value: "84.50" });
    expect(seed.amountMinor).toBe(4850);
    expect(seed.issues).toContain("amount_disagrees");
    expect(seed.fieldStates.amount).toBe("uncertain");
    expect(seed.included).toBe(true);
  });

  it("flags a lone separator followed by three digits as unclear", () => {
    const seed = row({ amount_text: "CHF 1.234", amount_value: "1234", currency: "CHF" });
    expect(seed.amountMinor).toBe(123400);
    expect(seed.issues).toContain("thousands_inferred");
    expect(seed.fieldStates.amount).toBe("uncertain");
  });

  it("uses the model's currency for a plain number and its confidence for the state", () => {
    const seed = row({ amount_text: "48.50", currency_confidence: "likely" });
    expect(seed.currency).toBe("EUR");
    expect(seed.fieldStates.currency).toBe("uncertain");
  });

  it("takes a printed currency over a different one from the model and flags it", () => {
    const seed = row({ amount_text: "CHF 48.50", currency: "EUR" });
    expect(seed.currency).toBe("CHF");
    expect(seed.issues).toContain("currency_disagrees");
    expect(seed.fieldStates.currency).toBe("uncertain");
  });

  it("makes a row needing input when the amount cannot be read", () => {
    const seed = row({ amount_text: "48,5,0,0", amount_value: null });
    expect(seed.amountMinor).toBeNull();
    expect(seed.amountText).toBe("48,5,0,0");
    expect(seed.fieldStates.amount).toBe("unreadable");
    expect(seed.included).toBe(false);
    expect(isBlocking(seed.fieldStates)).toBe(true);
    expect(rowState(seed.fieldStates)).toBe("unreadable");
  });

  it("makes a row needing input when there is no amount at all", () => {
    const seed = row({ amount_text: null, amount_value: null, amount_confidence: "unreadable" });
    expect(seed.amountMinor).toBeNull();
    expect(seed.issues).toContain("amount_unreadable");
    expect(seed.included).toBe(false);
  });

  it("does not turn a refund into an expense", () => {
    const seed = row({ amount_text: "-€20,00", amount_value: "-20.00" });
    expect(seed.amountMinor).toBeNull();
    expect(seed.issues).toContain("negative_amount");
    expect(seed.included).toBe(false);
  });

  it("flags an amount the model read differently when its own value does not parse", () => {
    const seed = row({ amount_value: "forty eight" });
    expect(seed.amountMinor).toBe(4850);
    expect(seed.issues).toContain("amount_disagrees");
  });
});

describe("currency is never guessed", () => {
  it("needs input when the screen shows no currency", () => {
    const seed = row({ amount_text: "48.50", currency: null, currency_confidence: "unreadable" });
    expect(seed.currency).toBeNull();
    expect(seed.fieldStates.currency).toBe("unreadable");
    expect(seed.issues).toContain("currency_missing");
    expect(seed.included).toBe(false);
  });

  it("drops a currency the model only guessed", () => {
    const seed = row({ amount_text: "48.50", currency: "EUR", currency_confidence: "guess" });
    expect(seed.currency).toBeNull();
    expect(seed.included).toBe(false);
  });

  it("needs input for a bare dollar sign with no currency from the model", () => {
    const seed = row({ amount_text: "$12.00", currency: null, currency_confidence: "unreadable" });
    expect(seed.currency).toBeNull();
    expect(seed.included).toBe(false);
  });

  it("accepts a bare dollar sign when the model says SGD and flags the confidence", () => {
    const seed = row({
      amount_text: "$12.00",
      currency: "SGD",
      currency_confidence: "likely",
      amount_value: "12.00",
    });
    expect(seed.currency).toBe("SGD");
    expect(seed.amountMinor).toBe(1200);
    expect(seed.fieldStates.currency).toBe("uncertain");
  });

  it("ignores a currency code the app does not support", () => {
    const seed = row({ amount_text: "48.50", currency: "XYZ" });
    expect(seed.currency).toBeNull();
  });
});

describe("billed amounts", () => {
  it("keeps what the bank billed in another currency", () => {
    const seed = row({
      billed_amount_text: "S$75.20",
      billed_amount_value: "75.20",
      billed_currency: "SGD",
    });
    expect(seed.billedAmountMinor).toBe(7520);
    expect(seed.billedCurrency).toBe("SGD");
  });

  it("uses the model's billed currency for a plain number", () => {
    const seed = row({ billed_amount_text: "75.20", billed_currency: "SGD" });
    expect(seed.billedCurrency).toBe("SGD");
  });

  it("drops an unreadable billed amount and asks for a look at the amount", () => {
    const seed = row({ billed_amount_text: "see statement", billed_currency: "SGD" });
    expect(seed.billedAmountMinor).toBeNull();
    expect(seed.issues).toContain("billed_unreadable");
    expect(seed.fieldStates.amount).toBe("uncertain");
  });

  it("flags a billed amount whose text and own reading disagree", () => {
    const seed = row({
      billed_amount_text: "S$1.234",
      billed_amount_value: "1.23",
      billed_currency: "SGD",
    });
    expect(seed.issues).toContain("billed_amount_disagrees");
    expect(seed.fieldStates.amount).toBe("uncertain");
  });

  it("flags a billed currency that differs from the symbol in the text", () => {
    const seed = row({
      billed_amount_text: "S$75.20",
      billed_amount_value: "75.20",
      billed_currency: "USD",
    });
    expect(seed.issues).toContain("billed_currency_disagrees");
    expect(seed.fieldStates.amount).toBe("uncertain");
  });

  it("flags an ambiguous thousands separator in the billed amount", () => {
    const seed = row({
      billed_amount_text: "S$1.234",
      billed_amount_value: "1234.00",
      billed_currency: "SGD",
    });
    expect(seed.issues).toContain("billed_thousands_inferred");
    expect(seed.fieldStates.amount).toBe("uncertain");
  });

  it("leaves a consistent billed amount clear", () => {
    const seed = row({
      billed_amount_text: "S$75.20",
      billed_amount_value: "75.20",
      billed_currency: "SGD",
    });
    expect(seed.issues).toEqual([]);
    expect(seed.fieldStates.amount).toBe("clear");
  });

  it("takes an unlabeled figure beside a foreign amount as the SGD the card was charged", () => {
    // Trenitalia: "EUR 100" with a bare "144.26" in a Singapore card app.
    for (const billed_currency of [null, "SGD"]) {
      const seed = row({
        merchant: "Trenitalia - Lefrecce Roma Rmit",
        amount_text: "EUR 100",
        amount_value: "100.00",
        billed_amount_text: "144.26",
        billed_amount_value: "144.26",
        billed_currency,
      });
      expect(seed).toMatchObject({
        amountMinor: 10000,
        currency: "EUR",
        billedAmountMinor: 14426,
        billedCurrency: "SGD",
        billedAmountText: "144.26",
        included: true,
        issues: [],
      });
      expect(seed.fieldStates.amount).toBe("clear");
    }
  });

  it("keeps a billed currency the model reported over the SGD assumption", () => {
    const seed = row({ billed_amount_text: "75.20", billed_currency: "CHF" });
    expect(seed.billedCurrency).toBe("CHF");
  });

  it("still cannot read an unlabeled billed figure when there is no foreign amount to go by", () => {
    for (const amount of [
      { amount_text: "S$100.00", currency: "SGD" },
      { amount_text: "100.00", currency: null, currency_confidence: "unreadable" as const },
    ]) {
      const seed = row({ ...amount, billed_amount_text: "144.26", billed_currency: null });
      expect(seed.billedAmountMinor).toBeNull();
      expect(seed.billedCurrency).toBeNull();
      expect(seed.issues).toContain("billed_unreadable");
    }
  });

  it("reads any unlabeled billed figure beside a foreign amount as SGD (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("EUR", "CHF", "USD", "GBP"),
        fc.integer({ min: 1, max: 99_999_999 }),
        fc.integer({ min: 1, max: 99_999_999 }),
        (currency, amountMinor, billedMinor) => {
          const plain = (minor: number) =>
            `${String(Math.trunc(minor / 100))}.${String(minor % 100).padStart(2, "0")}`;
          const seed = row({
            amount_text: `${currency} ${plain(amountMinor)}`,
            amount_value: plain(amountMinor),
            currency,
            billed_amount_text: plain(billedMinor),
            billed_amount_value: plain(billedMinor),
            billed_currency: null,
          });
          // The same figure in the same currency adds nothing, so only SGD vs a foreign amount.
          expect(seed.currency).toBe(currency);
          expect(seed.amountMinor).toBe(amountMinor);
          expect(seed.billedCurrency).toBe("SGD");
          expect(seed.billedAmountMinor).toBe(billedMinor);
          expect(seed.issues).not.toContain("billed_unreadable");
        },
      ),
    );
  });

  it("drops a billed figure that repeats the amount", () => {
    const seed = row({ billed_amount_text: "€48,50", billed_currency: "EUR" });
    expect(seed.billedAmountMinor).toBeNull();
    expect(seed.issues).toEqual([]);
  });
});

describe("values the model marked unreadable", () => {
  it("are not kept, so a person must supply them", () => {
    const merchant = row({ merchant: "Cafe X", merchant_confidence: "unreadable" });
    expect(merchant.merchant).toBeNull();
    expect(merchant.included).toBe(false);

    const currency = row({
      amount_text: "48.50",
      currency: "EUR",
      currency_confidence: "unreadable",
    });
    expect(currency.currency).toBeNull();

    const amount = row({
      amount_text: "48.50",
      amount_value: "48.50",
      amount_confidence: "unreadable",
    });
    expect(amount.amountMinor).toBeNull();
    expect(amount.fieldStates.amount).toBe("unreadable");
  });
});

describe("dates, merchants and categories", () => {
  it("needs input when no date can be read", () => {
    for (const date of [null, "03/11/2026", "2026-02-30", "1999-01-01"]) {
      const seed = row({ date });
      expect(seed.spentOn).toBeNull();
      expect(seed.fieldStates.date).toBe("unreadable");
      expect(seed.included).toBe(false);
    }
    expect(row({ date: null }).issues).toContain("date_missing");
  });

  it("marks a date the model inferred as guessed", () => {
    const seed = row({ date: "2026-11-03", date_confidence: "guess" });
    expect(seed.spentOn).toBe("2026-11-03");
    expect(seed.fieldStates.date).toBe("guessed");
    expect(rowState(seed.fieldStates)).toBe("guessed");
    expect(seed.included).toBe(true);
  });

  it("treats an unreadable date confidence as missing even with a value", () => {
    const seed = row({ date_confidence: "unreadable" });
    expect(seed.spentOn).toBeNull();
  });

  it("flags a date well in the future but not tomorrow", () => {
    expect(row({ date: "2026-12-25" }).issues).toContain("future_date");
    expect(row({ date: "2026-12-25" }).fieldStates.date).toBe("uncertain");
    expect(row({ date: "2026-11-09" }).issues).toEqual([]);
  });

  it("needs input when no merchant can be read", () => {
    const seed = row({ merchant: "  ", merchant_confidence: "read" });
    expect(seed.merchant).toBeNull();
    expect(seed.fieldStates.merchant).toBe("unreadable");
    expect(seed.issues).toContain("merchant_missing");
    expect(row({ merchant: "X", merchant_confidence: "unreadable" }).included).toBe(false);
  });

  it("tidies whitespace in the merchant", () => {
    expect(row({ merchant: "  Trattoria \n  Roma " }).merchant).toBe("Trattoria Roma");
  });

  it("keeps a clear category, marks a middling one as a check and a low one as 'other' (guessed)", () => {
    expect(row({ category_confidence: 90 }).fieldStates.category).toBe("clear");
    const middling = row({ category: "stay", category_confidence: 60 });
    expect(middling.category).toBe("stay");
    expect(middling.fieldStates.category).toBe("uncertain");
    const low = row({ category: "stay", category_confidence: 20 });
    expect(low.category).toBe("other");
    expect(low.fieldStates.category).toBe("guessed");
    expect(low.issues).toContain("category_unsure");
    expect(low.included).toBe(true);
  });

  it("keeps the model's notes as note lines", () => {
    const seed = row({ notes: ["pending", "  "] });
    expect(seed.issues).toEqual(["note:pending"]);
  });
});

describe("whole extractions", () => {
  it("returns nothing for a picture that is not about payments", () => {
    const result = normalizeExtraction(
      extraction([transaction()], { readable: false, notes: ["a cat photo"] }),
      TODAY,
    );
    expect(result.rows).toEqual([]);
    expect(result.notes).toEqual(["a cat photo"]);
  });

  it("reads the total shown on screen, with the model's currency for a plain number", () => {
    const plain = normalizeExtraction(
      extraction([], { screen_total_text: "148.49", screen_total_currency: "EUR" }),
      TODAY,
    );
    expect(plain.screenTotal).toEqual({ text: "148.49", minor: 14849, currency: "EUR" });
    const unreadable = normalizeExtraction(
      extraction([], { screen_total_text: "lots", screen_total_currency: "EUR" }),
      TODAY,
    );
    expect(unreadable.screenTotal).toEqual({ text: "lots", minor: null, currency: "EUR" });
    const noCurrency = normalizeExtraction(
      extraction([], { screen_total_text: "148.49", screen_total_currency: null }),
      TODAY,
    );
    expect(noCurrency.screenTotal?.minor).toBeNull();
    expect(normalizeExtraction(extraction([]), TODAY).screenTotal).toBeNull();
  });

  it("orders states by how much attention they need", () => {
    expect(worseState("clear", "guessed")).toBe("guessed");
    expect(worseState("uncertain", "guessed")).toBe("uncertain");
    expect(worseState("unreadable", "uncertain")).toBe("unreadable");
    expect(worseState("clear", "clear")).toBe("clear");
  });
});
