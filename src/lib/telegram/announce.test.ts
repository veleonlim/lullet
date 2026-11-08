import { describe, expect, it } from "vitest";
import {
  announceExpenseAdded,
  announceImportConfirmed,
  notifyExpenseDeleted,
  notifyExpenseEdited,
  notifyImportUndone,
  type ExpenseBrief,
} from "./announce";

const brief = (over: Partial<ExpenseBrief> = {}): ExpenseBrief => ({
  id: "e1",
  description: "Trattoria",
  amountMinor: 4850,
  currency: "EUR",
  spentOn: "2026-11-03",
  ...over,
});

describe("announcements", () => {
  it("summarises a confirmed import with totals per currency", () => {
    const text = announceImportConfirmed("Alex", [
      brief(),
      brief({ description: "Cable car", amountMinor: 3000, currency: "CHF" }),
    ]);
    expect(text.split("\n")[0]).toBe(
      "<b>Alex</b> added 2 expenses from a screenshot: €48.50 + CHF\u00a030.00",
    );
    expect(text).toContain("Trattoria, €48.50; Cable car, CHF\u00a030.00");
  });

  it("says singular for one and truncates long lists", () => {
    expect(announceImportConfirmed("Alex", [brief()])).toContain("added 1 expense from");
    const many = Array.from({ length: 9 }, (_, i) => brief({ description: `Item ${String(i)}` }));
    expect(announceImportConfirmed("Alex", many)).toContain("; and 4 more");
  });

  it("escapes names and descriptions", () => {
    expect(announceExpenseAdded("A<b>", brief({ description: "x & <i>y" }), "M&M")).toBe(
      "<b>A&lt;b&gt;</b> added x &amp; &lt;i&gt;y, €48.50 (paid by M&amp;M).",
    );
  });

  it("describes edits and deletes for the people affected", () => {
    expect(notifyExpenseEdited("Mei", brief(), brief({ amountMinor: 5200 }), "https://x/e/1")).toBe(
      "<b>Mei</b> edited Trattoria, €52.00 that you are part of: €48.50 is now €52.00.\nhttps://x/e/1",
    );
    expect(notifyExpenseEdited("Mei", brief(), brief({ description: "Pizza" }), "l")).toContain(
      "the details or the split changed",
    );
    expect(notifyExpenseDeleted("Mei", brief())).toBe(
      "<b>Mei</b> deleted Trattoria, €48.50, which you were part of.",
    );
    expect(notifyImportUndone("Mei", [brief(), brief()])).toContain("2 expenses removed (€97.00)");
  });

  it("copes with a currency it does not format", () => {
    expect(announceExpenseAdded("A", brief({ currency: "XXX", amountMinor: 5 }), "A")).toContain(
      "5 XXX",
    );
  });
});
