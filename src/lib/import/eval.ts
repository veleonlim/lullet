import { z } from "zod";
import { CATEGORY_IDS } from "@/lib/ledger/categories";
import { isCurrencyCode, parseAmount } from "@/lib/money";
import { merchantsMatch } from "./duplicates";
import type { DraftRowSeed, RowField } from "./normalize";

/**
 * Scoring for the manual accuracy eval (`pnpm eval:screenshots`): real, redacted screenshots with
 * hand-written golden answers, run against the live model. This file is only the maths; it makes
 * no calls and is unit tested. The result decides whether Haiku stays the default or Sonnet does.
 */

export const goldenRowSchema = z.object({
  merchant: z.string(),
  /** YYYY-MM-DD */
  date: z.string(),
  /** A plain decimal with a dot, for example "48.50". */
  amount: z.string(),
  currency: z.string(),
  billedAmount: z.string().optional(),
  billedCurrency: z.string().optional(),
  category: z.enum(CATEGORY_IDS),
});
export type GoldenRow = z.infer<typeof goldenRowSchema>;

export const goldenSchema = z.object({ transactions: z.array(goldenRowSchema) });
export type Golden = z.infer<typeof goldenSchema>;

export const EVAL_FIELDS = [
  "merchant",
  "date",
  "amount",
  "currency",
  "billed",
  "category",
] as const;
export type EvalField = (typeof EVAL_FIELDS)[number];

export interface FieldTally {
  correct: number;
  total: number;
  /** Wrong values the review screen would NOT have marked "check" or "needs input". */
  silentErrors: number;
}

export interface ImageScore {
  readonly goldenRows: number;
  readonly readRows: number;
  readonly missed: number;
  readonly extra: number;
  readonly fields: Readonly<Record<EvalField, FieldTally>>;
}

function goldenMinor(amount: string | undefined, currency: string | undefined): number | null {
  if (amount === undefined || currency === undefined || !isCurrencyCode(currency)) return null;
  const result = parseAmount(amount, { currency });
  return result.ok ? result.minor : null;
}

function emptyTallies(): Record<EvalField, FieldTally> {
  return Object.fromEntries(
    EVAL_FIELDS.map((field) => [field, { correct: 0, total: 0, silentErrors: 0 }]),
  ) as Record<EvalField, FieldTally>;
}

/** Pairs each golden row with the unused read row that has the same amount, else the same position. */
function pair(golden: readonly GoldenRow[], rows: readonly DraftRowSeed[]) {
  const used = new Set<number>();
  return golden.map((row, index) => {
    const minor = goldenMinor(row.amount, row.currency);
    let found = rows.findIndex(
      (candidate, at) =>
        !used.has(at) && candidate.amountMinor === minor && candidate.currency === row.currency,
    );
    if (found < 0 && index < rows.length && !used.has(index)) found = index;
    if (found >= 0) used.add(found);
    return { golden: row, read: found >= 0 ? (rows[found] ?? null) : null };
  });
}

export function scoreImage(golden: Golden, rows: readonly DraftRowSeed[]): ImageScore {
  const fields = emptyTallies();
  let missed = 0;
  const pairs = pair(golden.transactions, rows);

  for (const { golden: want, read } of pairs) {
    if (!read) missed += 1;
    const wantMinor = goldenMinor(want.amount, want.currency);
    const wantBilled = goldenMinor(want.billedAmount, want.billedCurrency);
    const checks: Record<EvalField, { ok: boolean; state: RowField | null }> = {
      merchant: {
        ok: read !== null && merchantsMatch(read.merchant, want.merchant),
        state: "merchant",
      },
      date: { ok: read?.spentOn === want.date, state: "date" },
      amount: { ok: read !== null && read.amountMinor === wantMinor, state: "amount" },
      currency: { ok: read?.currency === want.currency, state: "currency" },
      billed: {
        ok:
          read !== null &&
          (wantBilled === null
            ? read.billedAmountMinor === null
            : read.billedAmountMinor === wantBilled && read.billedCurrency === want.billedCurrency),
        state: "amount",
      },
      category: { ok: read?.category === want.category, state: "category" },
    };
    for (const field of EVAL_FIELDS) {
      const check = checks[field];
      const tally = fields[field];
      tally.total += 1;
      if (check.ok) {
        tally.correct += 1;
      } else if (
        read &&
        check.state &&
        (read.fieldStates[check.state] ?? "clear") === "clear" &&
        read.included
      ) {
        tally.silentErrors += 1;
      }
    }
  }
  return {
    goldenRows: golden.transactions.length,
    readRows: rows.length,
    missed,
    extra: Math.max(0, rows.length - golden.transactions.length),
    fields,
  };
}

export interface EvalSummary {
  readonly images: number;
  readonly goldenRows: number;
  readonly missed: number;
  readonly extra: number;
  readonly fields: Readonly<Record<EvalField, FieldTally & { accuracy: number }>>;
  /** Share of all field values that were right. */
  readonly overall: number;
}

/** Adds up the per image scores. Accuracy is a whole number of percent, rounded half up with integers. */
export function summarize(scores: readonly ImageScore[]): EvalSummary {
  const fields = emptyTallies();
  let goldenRows = 0;
  let missed = 0;
  let extra = 0;
  for (const score of scores) {
    goldenRows += score.goldenRows;
    missed += score.missed;
    extra += score.extra;
    for (const field of EVAL_FIELDS) {
      fields[field].correct += score.fields[field].correct;
      fields[field].total += score.fields[field].total;
      fields[field].silentErrors += score.fields[field].silentErrors;
    }
  }
  const percent = (correct: number, total: number) =>
    total === 0 ? 100 : Math.trunc((correct * 200 + total) / (total * 2));
  const withAccuracy = Object.fromEntries(
    EVAL_FIELDS.map((field) => [
      field,
      { ...fields[field], accuracy: percent(fields[field].correct, fields[field].total) },
    ]),
  ) as EvalSummary["fields"];
  const correct = EVAL_FIELDS.reduce((sum, field) => sum + fields[field].correct, 0);
  const total = EVAL_FIELDS.reduce((sum, field) => sum + fields[field].total, 0);
  return {
    images: scores.length,
    goldenRows,
    missed,
    extra,
    fields: withAccuracy,
    overall: percent(correct, total),
  };
}
