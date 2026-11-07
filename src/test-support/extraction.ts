import type { Extraction, ExtractedTransaction } from "@/lib/import/extraction";

/** A clear, fully read transaction; override what a test is about. */
export function transaction(overrides: Partial<ExtractedTransaction> = {}): ExtractedTransaction {
  return {
    merchant: "Trattoria Roma",
    merchant_confidence: "read",
    date_text: "3 Nov 2026",
    date: "2026-11-03",
    date_confidence: "read",
    amount_text: "€48,50",
    amount_value: "48.50",
    amount_confidence: "read",
    currency: "EUR",
    currency_confidence: "read",
    billed_amount_text: null,
    billed_amount_value: null,
    billed_currency: null,
    category: "food",
    category_confidence: 95,
    notes: [],
    ...overrides,
  };
}

export function extraction(
  transactions: readonly ExtractedTransaction[],
  overrides: Partial<Extraction> = {},
): Extraction {
  return {
    readable: true,
    transactions: [...transactions],
    screen_total_text: null,
    screen_total_currency: null,
    notes: [],
    ...overrides,
  };
}

/** The wireframe from the design: Trattoria 48.50, Metro 12.00, AMZN 23.99 (check), Louvre 64.00. */
export function wireframeExtraction(): Extraction {
  return extraction(
    [
      transaction(),
      transaction({
        merchant: "Metro Roma",
        amount_text: "€12,00",
        amount_value: "12.00",
        category: "transport",
      }),
      transaction({
        merchant: "AMZN Mktp",
        amount_text: "€23,99",
        amount_value: "23.99",
        amount_confidence: "likely",
        category: "shopping",
        category_confidence: 60,
      }),
      transaction({
        merchant: "Louvre",
        date_text: "4 Nov 2026",
        date: "2026-11-04",
        amount_text: "€64,00",
        amount_value: "64.00",
        category: "sightseeing",
      }),
    ],
    { screen_total_text: "€148,49", screen_total_currency: "EUR" },
  );
}
