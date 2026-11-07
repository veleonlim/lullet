import fc from "fast-check";
import { CURRENCY_CODES, type CurrencyCode } from "@/lib/money/currency";
import { createRateBook, type RateBook } from "@/lib/money/convert";
import type { Allocation, MemberId } from "@/lib/money/allocate";
import { allocateProportional } from "@/lib/money/allocate";
import type { LedgerExpense, LedgerSettlement } from "@/lib/money/ledger";
import { parseRate, type Rate } from "@/lib/money/rate";

/** Fast-check generators shared by the money and ledger property tests. */

export const arbCurrency: fc.Arbitrary<CurrencyCode> = fc.constantFrom(...CURRENCY_CODES);

/** The trip currencies, which dominate real data. */
export const arbTripCurrency: fc.Arbitrary<CurrencyCode> = fc.constantFrom("SGD", "EUR", "CHF");

/** A positive amount up to 1,000,000.00 in a 2 digit currency. */
export const arbPositiveMinor = fc.integer({ min: 1, max: 100_000_000 });

export const arbMinor = fc.integer({ min: 0, max: 100_000_000 });

/** Amounts large enough to stress intermediate products, still safe integers. */
export const arbHugeMinor = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

export const arbRate: fc.Arbitrary<Rate> = fc
  .tuple(fc.integer({ min: 1, max: 99_999_999 }), fc.integer({ min: 4, max: 10 }))
  .map(([numerator, scale]) => ({ numerator: BigInt(numerator), scale }));

export const arbIsoDate: fc.Arbitrary<string> = fc
  .date({
    min: new Date("2020-01-01T00:00:00Z"),
    max: new Date("2030-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

export function memberIds(count: number): MemberId[] {
  return Array.from({ length: count }, (_, i) => `m${i + 1}`);
}

/** Non-empty subset of `members`, in their original order. */
export function arbSubset(members: readonly MemberId[]): fc.Arbitrary<MemberId[]> {
  return fc
    .array(fc.boolean(), { minLength: members.length, maxLength: members.length })
    .map((flags) => members.filter((_, i) => flags[i]))
    .filter((subset) => subset.length > 0);
}

/** Random positive weights for `ids`, at least one positive. */
function arbWeights(count: number): fc.Arbitrary<number[]> {
  return fc
    .array(fc.integer({ min: 0, max: 20 }), { minLength: count, maxLength: count })
    .filter((weights) => weights.some((w) => w > 0));
}

/** An expense whose payers and shares are valid allocations of its amount. */
export function arbExpense(members: readonly MemberId[], id: string): fc.Arbitrary<LedgerExpense> {
  return fc
    .record({
      amountMinor: arbPositiveMinor,
      currency: arbTripCurrency,
      date: fc.constantFrom("2026-11-01", "2026-11-02", "2026-11-03"),
      payerIds: arbSubset(members),
      shareIds: arbSubset(members),
      billedCurrency: fc.constantFrom("none", "SGD", "CHF"),
      billedSgd: arbPositiveMinor,
    })
    .chain((e) =>
      fc.tuple(arbWeights(e.payerIds.length), arbWeights(e.shareIds.length)).map(([pw, sw]) => {
        const payerMinors = allocateProportional(e.amountMinor, pw);
        const shareMinors = allocateProportional(e.amountMinor, sw);
        const payers: Allocation[] = e.payerIds.map((memberId, i) => ({
          memberId,
          minor: payerMinors[i] ?? 0,
        }));
        const shares: Allocation[] = e.shareIds.map((memberId, i) => ({
          memberId,
          minor: shareMinors[i] ?? 0,
        }));
        return {
          id,
          date: e.date,
          amountMinor: e.amountMinor,
          currency: e.currency,
          billed:
            e.billedCurrency === "none"
              ? undefined
              : { amountMinor: e.billedSgd, currency: e.billedCurrency },
          rate: undefined,
          payers,
          shares,
        } satisfies LedgerExpense;
      }),
    );
}

export function arbSettlement(
  members: readonly MemberId[],
  id: string,
): fc.Arbitrary<LedgerSettlement> {
  return fc
    .record({
      from: fc.integer({ min: 0, max: members.length - 1 }),
      offset: fc.integer({ min: 1, max: members.length - 1 }),
      amountMinor: arbPositiveMinor,
      currency: arbTripCurrency,
    })
    .map(({ from, offset, amountMinor, currency }) => ({
      id,
      date: "2026-11-03",
      fromMemberId: members[from]!,
      toMemberId: members[(from + offset) % members.length]!,
      amountMinor,
      currency,
    }));
}

/** Market rates for every trip currency and the days used by the generators. */
export function tripRateBook(): RateBook {
  const market = ["2026-11-01", "2026-11-02", "2026-11-03"].flatMap((date) => [
    { date, currency: "EUR" as const, rate: "1.4344" },
    { date, currency: "CHF" as const, rate: "1.5603" },
  ]);
  const overrides = [{ date: "2026-11-02", currency: "EUR" as const, rate: parseRate("1.51") }];
  return createRateBook({ market, overrides });
}

export function arbLedger(memberCount: number) {
  const members = memberIds(memberCount);
  return fc
    .record({
      expenses: fc
        .integer({ min: 0, max: 8 })
        .chain((n) =>
          fc.tuple(...Array.from({ length: n }, (_, i) => arbExpense(members, `e${i}`))),
        ),
      settlements: fc
        .integer({ min: 0, max: 3 })
        .chain((n) =>
          fc.tuple(...Array.from({ length: n }, (_, i) => arbSettlement(members, `s${i}`))),
        ),
    })
    .map(({ expenses, settlements }) => ({
      members,
      expenses,
      settlements,
      rates: tripRateBook(),
    }));
}
