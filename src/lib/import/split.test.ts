import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateRow,
  computeTotals,
  defaultMembers,
  evenPercents,
  resolveSplit,
  sumByCurrency,
  type BatchSplit,
  type ResolvedSplit,
} from "./split";

const ORDER = ["a", "b", "c", "d"] as const;
const batch = (overrides: Partial<BatchSplit> = {}): BatchSplit => ({
  payerIds: ["a"],
  includePayers: false,
  mode: "equal",
  percents: null,
  ...overrides,
});

describe("defaultMembers", () => {
  it("is everyone but the payers, unless their own share is switched on", () => {
    expect(defaultMembers(ORDER, ["a"], false)).toEqual(["b", "c", "d"]);
    expect(defaultMembers(ORDER, ["a", "c"], false)).toEqual(["b", "d"]);
    expect(defaultMembers(ORDER, ["a"], true)).toEqual(["a", "b", "c", "d"]);
  });

  it("falls back to everyone when everyone paid", () => {
    expect(defaultMembers(ORDER, [...ORDER], false)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("evenPercents", () => {
  it("shares 100% with the spare basis points going first", () => {
    expect(evenPercents(["b", "c", "d"])).toEqual({ b: 3334, c: 3333, d: 3333 });
    expect(evenPercents(["a", "b"])).toEqual({ a: 5000, b: 5000 });
  });
});

describe("resolveSplit", () => {
  it("follows the batch: the remaining members split equally", () => {
    expect(resolveSplit(batch(), null, ORDER)).toEqual({
      ok: true,
      split: { mode: "equal", members: ["b", "c", "d"], basisPoints: null },
    });
  });

  it("lets one row drop a member (remove B from one transaction)", () => {
    const result = resolveSplit(batch(), { members: ["d", "c"] }, ORDER);
    expect(result).toEqual({
      ok: true,
      split: { mode: "equal", members: ["c", "d"], basisPoints: null },
    });
  });

  it("refuses a row nobody shares", () => {
    expect(resolveSplit(batch(), { members: [] }, ORDER)).toEqual({
      ok: false,
      message: "Pick at least one person to share this with",
    });
  });

  it("switches one row to percent with even percentages by default", () => {
    const result = resolveSplit(batch(), { mode: "percent" }, ORDER);
    expect(result).toEqual({
      ok: true,
      split: {
        mode: "percent",
        members: ["b", "c", "d"],
        basisPoints: { b: 3334, c: 3333, d: 3333 },
      },
    });
  });

  it("uses a row's own percentages and demands they total 100%", () => {
    const ok = resolveSplit(batch(), { mode: "percent", percents: { b: 6000, c: 4000 } }, ORDER);
    expect(ok).toMatchObject({ ok: true, split: { members: ["b", "c"] } });
    const bad = resolveSplit(batch(), { mode: "percent", percents: { b: 6000, c: 3000 } }, ORDER);
    expect(bad).toEqual({ ok: false, message: "Percentages add up to 90.00%, not 100%" });
  });

  it("applies a percent batch to rows without their own split", () => {
    const percentBatch = batch({ mode: "percent", percents: { a: 2500, b: 7500 } });
    expect(resolveSplit(percentBatch, null, ORDER)).toEqual({
      ok: true,
      split: { mode: "percent", members: ["a", "b"], basisPoints: { a: 2500, b: 7500 } },
    });
    // A row can still go back to an equal split among the default members.
    expect(resolveSplit(percentBatch, { mode: "equal" }, ORDER)).toMatchObject({
      split: { mode: "equal", members: ["b", "c", "d"] },
    });
    // Dropping a member of a percent row re-evens it unless percentages are given.
    expect(resolveSplit(percentBatch, { members: ["b", "c"] }, ORDER)).toMatchObject({
      split: { mode: "percent", basisPoints: { b: 5000, c: 5000 } },
    });
  });

  it("ignores members that are not in the group", () => {
    expect(resolveSplit(batch(), { members: ["b", "zzz"] }, ORDER)).toMatchObject({
      split: { members: ["b"] },
    });
  });
});

describe("allocateRow", () => {
  const equal = (members: string[]): ResolvedSplit => ({
    mode: "equal",
    members,
    basisPoints: null,
  });

  it("reproduces the design wireframe: 148.49 EUR, B owes 28.17, C 60.17, D 60.15", () => {
    const rows = [
      { minor: 4850, members: ["b", "c", "d"] },
      { minor: 1200, members: ["b", "c", "d"] },
      { minor: 2399, members: ["b", "c", "d"] },
      { minor: 6400, members: ["c", "d"] },
    ];
    const totals = computeTotals(
      rows.map((row) => ({ amountMinor: row.minor, currency: "EUR", split: equal(row.members) })),
      ["a"],
      ORDER,
    );
    const owes = Object.fromEntries(
      totals.map((t) => [t.userId, t.byCurrency.EUR?.owesMinor ?? 0]),
    );
    expect(owes.a).toBe(0);
    expect((owes.b ?? 0) + (owes.c ?? 0) + (owes.d ?? 0)).toBe(14849);
    expect(totals[0]?.byCurrency.EUR?.paidMinor).toBe(14849);
    // Spare cents go by the fixed member order within each row, so B, C and D differ by at most a few cents.
    expect(owes).toEqual({ a: 0, b: 2817, c: 6017, d: 6015 });
  });

  it("splits a row between several payers equally and drops a payer who would pay nothing", () => {
    const two = allocateRow(1001, equal(["c"]), ["a", "b"], ORDER);
    expect(two.payers).toEqual([
      { userId: "a", amountMinor: 501 },
      { userId: "b", amountMinor: 500 },
    ]);
    const tiny = allocateRow(1, equal(["c"]), ["a", "b"], ORDER);
    expect(tiny.payers).toEqual([{ userId: "a", amountMinor: 1 }]);
  });

  it("allocates percent splits with the weights kept", () => {
    const result = allocateRow(
      1000,
      { mode: "percent", members: ["b", "c"], basisPoints: { b: 3333, c: 6667 } },
      ["a"],
      ORDER,
    );
    expect(result.splitMethod).toBe("percent");
    expect(result.shares).toEqual([
      { userId: "b", amountMinor: 333, weight: 3333 },
      { userId: "c", amountMinor: 667, weight: 6667 },
    ]);
  });

  it("needs a payer", () => {
    expect(() => allocateRow(100, equal(["b"]), [], ORDER)).toThrow("Pick who paid");
  });

  it("always adds payers and shares up to the amount, in any split", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.subarray([...ORDER], { minLength: 1 }),
        fc.subarray([...ORDER], { minLength: 1 }),
        (amount, payers, members) => {
          const result = allocateRow(amount, equal(members), payers, ORDER);
          expect(result.payers.reduce((s, p) => s + p.amountMinor, 0)).toBe(amount);
          expect(result.shares.reduce((s, p) => s + p.amountMinor, 0)).toBe(amount);
        },
      ),
    );
  });
});

describe("computeTotals and sumByCurrency", () => {
  it("keeps a figure per currency", () => {
    const rows = [
      {
        amountMinor: 1000,
        currency: "EUR",
        split: { mode: "equal", members: ["b", "c"], basisPoints: null },
      },
      {
        amountMinor: 500,
        currency: "CHF",
        split: { mode: "equal", members: ["b"], basisPoints: null },
      },
    ] as const;
    const totals = computeTotals(rows, ["a"], ORDER);
    expect(totals[1]?.byCurrency).toEqual({
      EUR: { paidMinor: 0, owesMinor: 500 },
      CHF: { paidMinor: 0, owesMinor: 500 },
    });
    expect(sumByCurrency(rows)).toEqual({ EUR: 1000, CHF: 500 });
  });

  it("ignores ids that are not in the group", () => {
    const totals = computeTotals(
      [
        {
          amountMinor: 100,
          currency: "EUR",
          split: { mode: "equal", members: ["b"], basisPoints: null },
        },
      ],
      ["a"],
      ["a", "b"],
    );
    expect(totals.map((t) => t.userId)).toEqual(["a", "b"]);
  });
});
