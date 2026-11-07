import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { equalSplit, type Allocation } from "./allocate";
import { createRateBook } from "./convert";
import {
  assertExpenseInvariants,
  computeBalances,
  expenseInReportingCurrency,
  type LedgerExpense,
  type LedgerSettlement,
} from "./ledger";
import { parseRate } from "./rate";
import { suggestTransfers } from "./settle";
import { arbLedger, tripRateBook } from "@/test-support/arbitraries";

const MEMBERS = ["A", "B", "C", "D"];
const rates = createRateBook({
  market: [
    { date: "2026-11-02", currency: "EUR", rate: "1.4344" },
    { date: "2026-11-02", currency: "CHF", rate: "1.5603" },
  ],
});

const only = (memberId: string, minor: number): Allocation[] => [{ memberId, minor }];

function expense(
  partial: Partial<LedgerExpense> & Pick<LedgerExpense, "id" | "amountMinor" | "payers" | "shares">,
): LedgerExpense {
  return { date: "2026-11-02", currency: "EUR", ...partial };
}

const reportExample: LedgerExpense[] = [
  { id: "trattoria", amountMinor: 4850, shares: equalSplit(4850, ["B", "C", "D"], MEMBERS) },
  { id: "metro", amountMinor: 1200, shares: equalSplit(1200, ["B", "C", "D"], MEMBERS) },
  { id: "amzn", amountMinor: 2399, shares: equalSplit(2399, ["B", "C", "D"], MEMBERS) },
  { id: "louvre", amountMinor: 6400, shares: equalSplit(6400, ["C", "D"], MEMBERS) },
].map((row) => expense({ ...row, payers: only("A", row.amountMinor) }));

const balanceOf = (list: readonly { memberId: string; balanceMinor: number }[], id: string) =>
  list.find((b) => b.memberId === id)?.balanceMinor;

describe("computeBalances: worked examples", () => {
  it("matches the agreed report example in the currency shown (B 28.17, C 60.17, D 60.15)", () => {
    const { byCurrency } = computeBalances({ members: MEMBERS, expenses: reportExample, rates });
    const eur = byCurrency.EUR ?? [];
    expect(balanceOf(eur, "A")).toBe(14849);
    expect(balanceOf(eur, "B")).toBe(-2817);
    expect(balanceOf(eur, "C")).toBe(-6017);
    expect(balanceOf(eur, "D")).toBe(-6015);
  });

  it("converts the same example to SGD with every side still adding up", () => {
    const { reporting } = computeBalances({ members: MEMBERS, expenses: reportExample, rates });
    expect(reporting.reduce((acc, b) => acc + b.balanceMinor, 0)).toBe(0);
    // 4850 + 1200 + 2399 + 6400 EUR at 1.4344, rounded per expense
    expect(balanceOf(reporting, "A")).toBe(6957 + 1721 + 3441 + 9180);
    expect(reporting.find((b) => b.memberId === "A")).toMatchObject({
      paidMinor: 21299,
      owedMinor: 0,
      settledMinor: 0,
    });
  });

  it("supports several payers on one expense", () => {
    const dinner = expense({
      id: "dinner",
      amountMinor: 10_000,
      payers: [
        { memberId: "A", minor: 6000 },
        { memberId: "B", minor: 4000 },
      ],
      shares: equalSplit(10_000, MEMBERS, MEMBERS),
    });
    const { byCurrency } = computeBalances({ members: MEMBERS, expenses: [dinner], rates });
    const eur = byCurrency.EUR ?? [];
    expect(eur.map((b) => b.balanceMinor)).toEqual([3500, 1500, -2500, -2500]);
  });

  it("a settlement moves a balance towards zero", () => {
    const settlement: LedgerSettlement = {
      id: "s1",
      date: "2026-11-02",
      fromMemberId: "B",
      toMemberId: "A",
      amountMinor: 2817,
      currency: "EUR",
    };
    const { byCurrency, reporting } = computeBalances({
      members: MEMBERS,
      expenses: reportExample,
      settlements: [settlement],
      rates,
    });
    const eur = byCurrency.EUR ?? [];
    expect(balanceOf(eur, "B")).toBe(0);
    expect(balanceOf(eur, "A")).toBe(14849 - 2817);
    expect(reporting.reduce((acc, b) => acc + b.balanceMinor, 0)).toBe(0);
    expect(reporting.find((b) => b.memberId === "B")?.settledMinor).toBeGreaterThan(0);
  });

  it("uses the billed SGD figure exactly for the reporting amounts", () => {
    const hotel = expense({
      id: "hotel",
      amountMinor: 21_240,
      billed: { amountMinor: 33_333, currency: "SGD" },
      payers: only("A", 21_240),
      shares: equalSplit(21_240, MEMBERS, MEMBERS),
    });
    const priced = expenseInReportingCurrency(hotel, rates, MEMBERS);
    expect(priced).toMatchObject({ totalMinor: 33_333, source: "billed" });
    expect(priced.shares.map((s) => s.minor)).toEqual([8334, 8333, 8333, 8333]);
    expect(priced.payers).toEqual([{ memberId: "A", minor: 33_333 }]);
  });

  it("settles up end to end: applying the suggested transfers leaves everyone square", () => {
    const first = computeBalances({ members: MEMBERS, expenses: reportExample, rates });
    const transfers = suggestTransfers(first.reporting);
    const settlements: LedgerSettlement[] = transfers.map((t, i) => ({
      id: `settle-${i}`,
      date: "2026-11-02",
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountMinor: t.minor,
      currency: "SGD",
    }));
    const after = computeBalances({
      members: MEMBERS,
      expenses: reportExample,
      settlements,
      rates,
    });
    expect(after.reporting.map((b) => b.balanceMinor)).toEqual([0, 0, 0, 0]);
  });

  it("breaks rounding ties by the group's member order, not by the order entries are stored", () => {
    const stored = expense({
      id: "e",
      amountMinor: 100,
      payers: only("A", 100),
      shares: [
        { memberId: "D", minor: 34 },
        { memberId: "B", minor: 33 },
        { memberId: "C", minor: 33 },
      ],
    });
    const priced = expenseInReportingCurrency(stored, rates, MEMBERS);
    expect(priced.shares.map((s) => s.memberId)).toEqual(["B", "C", "D"]);
    const reordered = expenseInReportingCurrency(
      { ...stored, shares: [...stored.shares].reverse() },
      rates,
      MEMBERS,
    );
    expect(reordered.shares).toEqual(priced.shares);
  });

  it("lists every member, including those with nothing to do with any expense", () => {
    const { reporting } = computeBalances({ members: MEMBERS, expenses: [], rates });
    expect(reporting).toHaveLength(4);
    expect(reporting.every((b) => b.balanceMinor === 0)).toBe(true);
  });

  it("fails loudly when an expense cannot be converted", () => {
    const eurOnAnUnratedDay = expense({
      id: "e",
      date: "2026-11-05",
      amountMinor: 100,
      payers: only("A", 100),
      shares: only("B", 100),
    });
    expect(() =>
      computeBalances({ members: MEMBERS, expenses: [eurOnAnUnratedDay], rates }),
    ).toThrow(expect.objectContaining({ code: "missing_rate" }));
  });
});

describe("expense invariants", () => {
  const good = expense({
    id: "e",
    amountMinor: 100,
    payers: only("A", 100),
    shares: equalSplit(100, ["A", "B"], MEMBERS),
  });

  it("accepts a consistent expense", () => {
    expect(() => assertExpenseInvariants(good)).not.toThrow();
  });

  it.each([
    [
      "shares that do not add up",
      { shares: [{ memberId: "A", minor: 99 }] },
      "split_total_mismatch",
    ],
    [
      "payers that do not add up",
      { payers: [{ memberId: "A", minor: 101 }] },
      "payer_total_mismatch",
    ],
    ["no payers", { payers: [] }, "invalid_expense"],
    ["no shares", { shares: [] }, "invalid_expense"],
    [
      "a member listed twice",
      {
        shares: [
          { memberId: "A", minor: 50 },
          { memberId: "A", minor: 50 },
        ],
      },
      "duplicate_member",
    ],
  ] as const)("rejects %s", (_label, patch, code) => {
    expect(() => assertExpenseInvariants({ ...good, ...patch })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects bad amounts, dates and billed figures", () => {
    expect(() => assertExpenseInvariants({ ...good, amountMinor: 0 })).toThrow(RangeError);
    expect(() => assertExpenseInvariants({ ...good, date: "2026-13-01" })).toThrow(RangeError);
    expect(() =>
      assertExpenseInvariants({ ...good, billed: { amountMinor: 0, currency: "SGD" } }),
    ).toThrow(RangeError);
    expect(() =>
      assertExpenseInvariants({
        ...good,
        shares: [
          { memberId: "A", minor: -1 },
          { memberId: "B", minor: 101 },
        ],
      }),
    ).toThrow(RangeError);
  });

  it("rejects unknown members and bad member lists when computing balances", () => {
    const stranger = expense({
      id: "e",
      amountMinor: 100,
      payers: only("Z", 100),
      shares: only("A", 100),
    });
    expect(() => computeBalances({ members: MEMBERS, expenses: [stranger], rates })).toThrow(
      expect.objectContaining({ code: "unknown_member" }),
    );
    expect(() => computeBalances({ members: ["A", "A"], expenses: [], rates })).toThrow(
      expect.objectContaining({ code: "duplicate_member" }),
    );
    const selfPay: LedgerSettlement = {
      id: "s",
      date: "2026-11-02",
      fromMemberId: "A",
      toMemberId: "A",
      amountMinor: 1,
      currency: "SGD",
    };
    expect(() =>
      computeBalances({ members: MEMBERS, expenses: [], settlements: [selfPay], rates }),
    ).toThrow(expect.objectContaining({ code: "invalid_expense" }));
    const ghost: LedgerSettlement = { ...selfPay, toMemberId: "Z" };
    expect(() =>
      computeBalances({ members: MEMBERS, expenses: [], settlements: [ghost], rates }),
    ).toThrow(expect.objectContaining({ code: "unknown_member" }));
  });

  it("uses a per-expense rate when present", () => {
    const withRate = expense({ ...good, id: "r", rate: parseRate("2") });
    expect(expenseInReportingCurrency(withRate, rates, MEMBERS)).toMatchObject({
      totalMinor: 200,
      source: "expense_rate",
    });
  });
});

describe("ledger properties", () => {
  const sumOf = (list: readonly { balanceMinor: number }[]) =>
    list.reduce((acc, b) => acc + b.balanceMinor, 0);

  it("balances always sum to zero, in SGD and in every native currency", () => {
    fc.assert(
      fc.property(arbLedger(4), (ledger) => {
        const { reporting, byCurrency } = computeBalances(ledger);
        expect(sumOf(reporting)).toBe(0);
        for (const list of Object.values(byCurrency)) expect(sumOf(list)).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it("every expense is priced so both sides add up to the same SGD total", () => {
    fc.assert(
      fc.property(arbLedger(4), (ledger) => {
        for (const e of ledger.expenses) {
          const priced = expenseInReportingCurrency(e, ledger.rates, ledger.members);
          expect(priced.payers.reduce((a, p) => a + p.minor, 0)).toBe(priced.totalMinor);
          expect(priced.shares.reduce((a, s) => a + s.minor, 0)).toBe(priced.totalMinor);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("total paid equals total owed across the group", () => {
    fc.assert(
      fc.property(arbLedger(3), (ledger) => {
        const { reporting } = computeBalances(ledger);
        expect(reporting.reduce((a, b) => a + b.paidMinor, 0)).toBe(
          reporting.reduce((a, b) => a + b.owedMinor, 0),
        );
      }),
    );
  });

  it("does not depend on the order expenses or their entries are listed in", () => {
    fc.assert(
      fc.property(arbLedger(4), (ledger) => {
        const baseline = computeBalances(ledger);
        const shuffled = computeBalances({
          ...ledger,
          expenses: [...ledger.expenses].reverse().map((e) => ({
            ...e,
            payers: [...e.payers].reverse(),
            shares: [...e.shares].reverse(),
          })),
          settlements: [...ledger.settlements].reverse(),
        });
        expect(shuffled).toEqual(baseline);
      }),
      { numRuns: 200 },
    );
  });

  it("paying the suggested transfers always squares the group", () => {
    fc.assert(
      fc.property(arbLedger(4), (ledger) => {
        const { reporting } = computeBalances(ledger);
        const settlements: LedgerSettlement[] = [
          ...ledger.settlements,
          ...suggestTransfers(reporting).map((t, i) => ({
            id: `auto-${i}`,
            date: "2026-11-03",
            fromMemberId: t.fromMemberId,
            toMemberId: t.toMemberId,
            amountMinor: t.minor,
            currency: "SGD" as const,
          })),
        ];
        const after = computeBalances({ ...ledger, settlements });
        expect(after.reporting.every((b) => b.balanceMinor === 0)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("is a plain function of its inputs", () => {
    fc.assert(
      fc.property(arbLedger(4), (ledger) => {
        expect(computeBalances(ledger)).toEqual(
          computeBalances({ ...ledger, rates: tripRateBook() }),
        );
      }),
      { numRuns: 100 },
    );
  });
});
