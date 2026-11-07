import { CATEGORY_IDS, type CategoryId } from "@/lib/ledger/categories";
import {
  isCurrencyCode,
  isIsoDate,
  parseAmount,
  type CurrencyCode,
  type IsoDate,
  type ParseResult,
} from "@/lib/money";
import type { Extraction, ExtractedTransaction, FieldConfidence } from "./extraction";
import { dayDistance } from "./days";

/**
 * Turns what the model read into draft rows, with the doubts our own checks add. Our code
 * re-reads every amount from the text shown on screen with the money library; where the model's
 * reading disagrees, or the text is ambiguous, the row is flagged for a person. Nothing is
 * silently fixed and no currency is ever guessed.
 */

/** How sure we are of one field of a row. */
export type FieldState = "clear" | "uncertain" | "guessed" | "unreadable";
export type RowField = "merchant" | "date" | "amount" | "currency" | "category";
export type FieldStates = Partial<Record<RowField, FieldState>>;

/** Category confidence from the model (0 to 100): at or above clear; below guessed becomes "other". */
export const CATEGORY_CLEAR_AT = 75;
export const CATEGORY_GUESS_BELOW = 50;

export interface DraftRowSeed {
  readonly merchant: string | null;
  readonly dateText: string | null;
  readonly spentOn: IsoDate | null;
  readonly amountText: string | null;
  readonly amountMinor: number | null;
  readonly currency: CurrencyCode | null;
  readonly billedAmountText: string | null;
  readonly billedAmountMinor: number | null;
  readonly billedCurrency: CurrencyCode | null;
  readonly category: CategoryId;
  readonly categoryConfidence: number;
  /** Unreadable rows start unchecked so they cannot slip into the ledger. */
  readonly included: boolean;
  /** Stable codes (see `ISSUE_TEXT`) and `note:` lines from the model. */
  readonly issues: readonly string[];
  readonly fieldStates: FieldStates;
}

export interface NormalizedExtraction {
  readonly rows: readonly DraftRowSeed[];
  readonly screenTotal: {
    readonly text: string;
    readonly minor: number | null;
    readonly currency: CurrencyCode | null;
  } | null;
  readonly notes: readonly string[];
}

/** What each issue code means, as shown to the person reviewing. */
export const ISSUE_TEXT: Readonly<Record<string, string>> = {
  amount_disagrees: "The amount read from the text differs from the model's own reading",
  thousands_inferred: "The amount could be 1.234 or 1,234: check the decimals",
  currency_disagrees: "The currency in the amount differs from the one the model reported",
  amount_unreadable: "The amount could not be read",
  negative_amount: "This looks like a refund or credit",
  billed_unreadable: "The billed amount could not be read and was left out",
  billed_amount_disagrees:
    "The billed amount read from the text differs from the model's own reading",
  billed_currency_disagrees:
    "The currency in the billed amount differs from the one the model reported",
  billed_thousands_inferred: "The billed amount could be 1.234 or 1,234: check the decimals",
  date_missing: "No date could be read",
  future_date: "The date is in the future",
  merchant_missing: "No merchant could be read",
  currency_missing: "The currency is not shown",
  category_unsure: "The category is a guess",
  possible_duplicate: "Looks like an expense that is already recorded",
};

const STATE_ORDER: readonly FieldState[] = ["clear", "guessed", "uncertain", "unreadable"];

export function worseState(a: FieldState, b: FieldState): FieldState {
  return STATE_ORDER.indexOf(a) >= STATE_ORDER.indexOf(b) ? a : b;
}

function fromConfidence(confidence: FieldConfidence): FieldState {
  switch (confidence) {
    case "read":
      return "clear";
    case "likely":
      return "uncertain";
    case "guess":
      return "guessed";
    case "unreadable":
      return "unreadable";
  }
}

function cleanText(value: string | null): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

function asCurrency(value: string | null): CurrencyCode | null {
  const code = value?.trim().toUpperCase();
  return code && isCurrencyCode(code) ? code : null;
}

interface ReadAmount {
  readonly minor: number | null;
  readonly currency: CurrencyCode | null;
  readonly state: FieldState;
  readonly currencyState: FieldState;
  readonly issues: readonly string[];
}

function parsed(result: ParseResult): result is Extract<ParseResult, { ok: true }> {
  return result.ok;
}

/** Reads an amount from the text shown, using the model's currency only when the text has none. */
function readAmount(input: {
  text: string | null;
  value: string | null;
  confidence: FieldConfidence;
  currency: CurrencyCode | null;
  currencyState: FieldState;
}): ReadAmount {
  const issues: string[] = [];
  const text = cleanText(input.text);
  let state = fromConfidence(input.confidence);
  let currencyState = input.currencyState;
  if (text === null) {
    return {
      minor: null,
      currency: input.currency,
      state: "unreadable",
      currencyState,
      issues: ["amount_unreadable"],
    };
  }

  // The text first on its own: a symbol or code in it is the currency as shown.
  const alone = parseAmount(text);
  let result: ParseResult = alone;
  let currency: CurrencyCode | null = input.currency;
  if (parsed(alone)) {
    // A symbol or code printed in the amount is what the screen shows: it settles the currency,
    // unless the model reported a different one, which a person must look at.
    currency = alone.currency;
    if (input.currency && input.currency !== alone.currency) {
      issues.push("currency_disagrees");
      currencyState = "uncertain";
    } else {
      currencyState = "clear";
    }
  } else if (alone.reason === "currency_unknown" && input.currency) {
    result = parseAmount(text, { currency: input.currency });
  }

  if (!parsed(result)) {
    return {
      minor: null,
      currency,
      state: "unreadable",
      currencyState,
      issues: [...issues, "amount_unreadable"],
    };
  }
  if (result.warnings.includes("thousands_inferred")) {
    issues.push("thousands_inferred");
    state = worseState(state, "uncertain");
  }
  if (result.minor <= 0) {
    return {
      minor: null,
      currency: result.currency,
      state: "unreadable",
      currencyState,
      issues: [...issues, "negative_amount"],
    };
  }
  if (state === "unreadable") {
    return {
      minor: null,
      currency: result.currency,
      state,
      currencyState,
      issues: [...issues, "amount_unreadable"],
    };
  }

  const own = cleanText(input.value);
  if (own !== null) {
    const second = parseAmount(own, { currency: result.currency });
    if (!parsed(second) || second.minor !== result.minor) {
      issues.push("amount_disagrees");
      state = worseState(state, "uncertain");
    }
  }
  return { minor: result.minor, currency: result.currency, state, currencyState, issues };
}

function readBilled(
  tx: ExtractedTransaction,
  amountCurrency: CurrencyCode | null,
  amountMinor: number | null,
): {
  text: string | null;
  minor: number | null;
  currency: CurrencyCode | null;
  issues: string[];
} {
  const text = cleanText(tx.billed_amount_text);
  if (text === null) return { text: null, minor: null, currency: null, issues: [] };
  const modelCurrency = asCurrency(tx.billed_currency);
  const alone = parseAmount(text);
  const result = parsed(alone)
    ? alone
    : alone.reason === "currency_unknown" && modelCurrency
      ? parseAmount(text, { currency: modelCurrency })
      : alone;
  if (!parsed(result) || result.minor <= 0) {
    return { text, minor: null, currency: null, issues: ["billed_unreadable"] };
  }
  // The same figure in the same currency adds nothing.
  if (result.currency === amountCurrency && result.minor === amountMinor) {
    return { text, minor: null, currency: null, issues: [] };
  }
  const issues: string[] = [];
  if (modelCurrency && modelCurrency !== result.currency) issues.push("billed_currency_disagrees");
  if (result.warnings.includes("thousands_inferred")) issues.push("billed_thousands_inferred");
  const own = cleanText(tx.billed_amount_value);
  if (own !== null) {
    const second = parseAmount(own, { currency: result.currency });
    if (!parsed(second) || second.minor !== result.minor) issues.push("billed_amount_disagrees");
  }
  return { text, minor: result.minor, currency: result.currency, issues };
}

function readDate(
  tx: ExtractedTransaction,
  today: IsoDate,
): { value: IsoDate | null; state: FieldState; issues: string[] } {
  const value = cleanText(tx.date);
  if (value === null || !isIsoDate(value) || value < "2000-01-01" || value > "2100-12-31") {
    return { value: null, state: "unreadable", issues: ["date_missing"] };
  }
  const state = fromConfidence(tx.date_confidence);
  if (state === "unreadable") return { value: null, state, issues: ["date_missing"] };
  if (isIsoDate(today) && dayDistance(today, value) > 1 && value > today) {
    return { value, state: worseState(state, "uncertain"), issues: ["future_date"] };
  }
  return { value, state, issues: [] };
}

function readCategory(tx: ExtractedTransaction): {
  category: CategoryId;
  state: FieldState;
  issues: string[];
} {
  const category = CATEGORY_IDS.includes(tx.category) ? tx.category : "other";
  if (tx.category_confidence >= CATEGORY_CLEAR_AT) return { category, state: "clear", issues: [] };
  if (tx.category_confidence >= CATEGORY_GUESS_BELOW) {
    return { category, state: "uncertain", issues: [] };
  }
  return { category: "other", state: "guessed", issues: ["category_unsure"] };
}

export function normalizeTransaction(tx: ExtractedTransaction, today: IsoDate): DraftRowSeed {
  const issues: string[] = [];
  const states: FieldStates = {};

  const merchant = cleanText(tx.merchant);
  states.merchant = merchant === null ? "unreadable" : fromConfidence(tx.merchant_confidence);
  if (merchant === null || states.merchant === "unreadable") {
    states.merchant = "unreadable";
    issues.push("merchant_missing");
  }

  // Currency is never guessed: only a currency the screen makes clear is used.
  const modelCurrency =
    tx.currency_confidence === "guess" || tx.currency_confidence === "unreadable"
      ? null
      : asCurrency(tx.currency);
  const modelCurrencyState: FieldState =
    modelCurrency === null ? "unreadable" : fromConfidence(tx.currency_confidence);
  const amount = readAmount({
    text: tx.amount_text,
    value: tx.amount_value,
    confidence: tx.amount_confidence,
    currency: modelCurrency,
    currencyState: modelCurrencyState,
  });
  states.amount = amount.state;
  states.currency = amount.currency === null ? "unreadable" : amount.currencyState;
  issues.push(...amount.issues);
  if (amount.currency === null) issues.push("currency_missing");

  const billed = readBilled(tx, amount.currency, amount.minor);
  issues.push(...billed.issues);
  if (billed.issues.length > 0) {
    states.amount = worseState(states.amount, "uncertain");
  }

  const date = readDate(tx, today);
  states.date = date.state;
  issues.push(...date.issues);

  const category = readCategory(tx);
  states.category = category.state;
  issues.push(...category.issues);

  for (const note of tx.notes) {
    const line = cleanText(note);
    if (line) issues.push(`note:${line.slice(0, 120)}`);
  }

  const unreadable = Object.values(states).includes("unreadable");
  return {
    merchant: states.merchant === "unreadable" ? null : merchant,
    dateText: cleanText(tx.date_text),
    spentOn: date.value,
    amountText: cleanText(tx.amount_text),
    amountMinor: amount.minor,
    currency: amount.currency,
    billedAmountText: billed.text,
    billedAmountMinor: billed.minor,
    billedCurrency: billed.currency,
    category: category.category,
    categoryConfidence: tx.category_confidence,
    included: !unreadable,
    issues,
    fieldStates: states,
  };
}

export function normalizeExtraction(extraction: Extraction, today: IsoDate): NormalizedExtraction {
  const rows = extraction.readable
    ? extraction.transactions.map((tx) => normalizeTransaction(tx, today))
    : [];
  const totalText = cleanText(extraction.screen_total_text);
  let screenTotal: NormalizedExtraction["screenTotal"] = null;
  if (totalText !== null) {
    const currency = asCurrency(extraction.screen_total_currency);
    const alone = parseAmount(totalText);
    const result = parsed(alone) ? alone : currency ? parseAmount(totalText, { currency }) : alone;
    screenTotal = {
      text: totalText,
      minor: parsed(result) ? result.minor : null,
      currency: parsed(result) ? result.currency : currency,
    };
  }
  const notes = extraction.notes.map(cleanText).filter((note): note is string => note !== null);
  return { rows, screenTotal, notes };
}

/** The doubt to show for a whole row: the worst of its fields. */
export function rowState(states: FieldStates): FieldState {
  return Object.values(states).reduce<FieldState>(
    (worst, state) => worseState(worst, state),
    "clear",
  );
}

/** True when the row cannot be added until a person fills something in. */
export function isBlocking(states: FieldStates): boolean {
  return Object.values(states).includes("unreadable");
}
