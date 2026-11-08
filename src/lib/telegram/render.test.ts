import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DraftRow, DraftView } from "@/lib/import";
import type { StoredExpense } from "@/lib/ledger/types";
import { decodeCallback } from "./callbacks";
import { MESSAGE_LIMIT } from "./html";
import {
  CHAT_CONFIRM_MAX_ROWS,
  chatConfirmBlocker,
  renderConfirmed,
  renderDraft,
  renderRowEditor,
  renderSummary,
  type Person,
  type RenderedMessage,
  type RenderInput,
} from "./render";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SECRET = "render-test-secret";
const members: Person[] = [
  { userId: "u-alex", displayName: "Alex" },
  { userId: "u-mei", displayName: "Mei" },
  { userId: "u-mum", displayName: "Mum" },
  { userId: "u-dad", displayName: "Dad" },
];
const order = members.map((m) => m.userId);

function row(position: number, over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: `row-${String(position)}`,
    position,
    merchant: `Shop ${String(position)}`,
    dateText: "3 Nov",
    spentOn: "2026-11-03",
    amountText: "10.00",
    amountMinor: 1000 + position,
    currency: "EUR",
    billedAmountText: null,
    billedAmountMinor: null,
    billedCurrency: null,
    category: "food",
    categoryConfidence: 90,
    included: true,
    issues: [],
    fieldStates: {},
    duplicateOf: null,
    split: null,
    ...over,
  };
}

function view(rows: DraftRow[], over: Partial<DraftView> = {}): DraftView {
  return {
    id: ID,
    status: "draft",
    uploaderId: "u-alex",
    createdAt: new Date("2026-11-08T10:00:00Z"),
    expiresAt: new Date("2026-11-09T10:00:00Z"),
    confirmedAt: null,
    undoneAt: null,
    model: "claude-haiku-5-5",
    extractionError: null,
    rereads: 0,
    notes: [],
    screenTotal: null,
    batch: { payerIds: ["u-alex"], includePayers: false, mode: "equal", percents: null },
    rows,
    imageAvailable: true,
    expenses: [],
    ...over,
  };
}

const input = (v: DraftView): RenderInput => ({
  view: v,
  members,
  secret: SECRET,
  appUrl: "https://app.test",
});
interface Button {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}
const buttons = (m: RenderedMessage): Button[] => m.keyboard.flat();
const labels = (m: RenderedMessage) => buttons(m).map((b) => b.text);

describe("the summary", () => {
  it("lists rows, who paid, the total and each person's share, with the agreed buttons", () => {
    const message = renderSummary(
      input(view([row(1), row(2, { merchant: "Louvre", split: { members: ["u-mum", "u-dad"] } })])),
    );
    expect(message.text).toContain("Paid by Alex. Shared equally between Mei, Mum, Dad.");
    expect(message.text).toContain("1. Shop 1, €10.01, Food");
    expect(message.text).toContain("2. Louvre, €10.02, Food, Mum, Dad");
    expect(message.text).toContain("Adding 2 of 2 rows:");
    expect(message.text).toContain("<b>€20.03</b> - shares: Mei €");
    expect(labels(message)).toEqual(["Confirm 2", "Edit rows", "Open in app", "Cancel"]);
    const app = buttons(message).find((b) => b.text === "Open in app");
    expect(app?.web_app?.url).toBe(
      `https://app.test/signin?next=${encodeURIComponent(`/imports/${ID}`)}`,
    );
  });

  it("carries only the draft id and a nonce in every button", () => {
    const message = renderSummary(input(view([row(1)])));
    for (const button of buttons(message)) {
      if (!button.callback_data) continue;
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      expect(decodeCallback(SECRET, button.callback_data)).toMatchObject({
        ok: true,
        importId: ID,
      });
    }
  });

  it("marks doubtful, unreadable, duplicate and unticked rows", () => {
    const message = renderSummary(
      input(
        view([
          row(1, { fieldStates: { amount: "uncertain" } }),
          row(2, { fieldStates: { amount: "unreadable" }, amountMinor: null, included: false }),
          row(3, {
            included: false,
            issues: ["possible_duplicate"],
            duplicateOf: {
              kind: "expense",
              id: "e",
              importId: null,
              label: "Hotel Lumiere, 2026-11-02",
            },
          }),
        ]),
      ),
    );
    expect(message.text).toContain("1. Shop 1, €10.01, Food <i>(check)</i>");
    expect(message.text).toContain("<i>(needs input, not included)</i>");
    expect(message.text).toContain("may repeat Hotel Lumiere, 2026-11-02, not included");
    expect(message.text).toContain("amount?");
  });

  it("offers Confirm only for a clean draft", () => {
    const base = [row(1), row(2)];
    const blockers = (v: DraftView) => chatConfirmBlocker(v, order);
    expect(blockers(view(base))).toBeNull();
    expect(blockers(view(base, { status: "confirmed" }))).toBe("closed");
    expect(blockers(view(base, { extractionError: "refused" }))).toBe(
      "The screenshot could not be read.",
    );
    expect(blockers(view([]))).toBe("No payments were found.");
    expect(
      blockers(view(Array.from({ length: CHAT_CONFIRM_MAX_ROWS + 1 }, (_, i) => row(i)))),
    ).toBe("More than 10 rows.");
    expect(
      blockers(view(Array.from({ length: CHAT_CONFIRM_MAX_ROWS }, (_, i) => row(i)))),
    ).toBeNull();
    expect(blockers(view([row(1, { fieldStates: { date: "unreadable" }, included: false })]))).toBe(
      "Some rows need input.",
    );
    expect(blockers(view([row(1, { issues: ["possible_duplicate"] })]))).toBe(
      "Some rows may already be recorded.",
    );
    expect(blockers(view([row(1, { included: false })]))).toBe("Tick at least one row to add");
    const badPercent = view([
      row(1, {
        split: {
          mode: "percent",
          members: ["u-mei", "u-mum"],
          percents: { "u-mei": 5000, "u-mum": 4000 },
        },
      }),
    ]);
    expect(blockers(badPercent)).toBe("One row needs attention before it can be added");
  });

  it("sends people to the app, without Confirm, when the draft needs review", () => {
    const message = renderSummary(input(view([row(1, { fieldStates: { amount: "unreadable" } })])));
    expect(labels(message)).not.toContain("Confirm 1");
    expect(message.text).toContain("Some rows need input. Open in app to review before adding.");
  });

  it("explains a failed or empty read and offers only the app and Cancel", () => {
    const failed = renderSummary(input(view([], { extractionError: "not_configured" })));
    expect(failed.text).toContain("Screenshot reading is not set up yet");
    expect(labels(failed)).toEqual(["Open in app", "Cancel"]);
    const empty = renderSummary(input(view([])));
    expect(empty.text).toContain("could not find any payments");
  });

  it("describes several payers, percent mode and model notes, and escapes everything typed", () => {
    const v = view([row(1, { merchant: "<b>Cafe & Co</b>" })], {
      batch: {
        payerIds: ["u-alex", "u-mei"],
        includePayers: true,
        mode: "percent",
        percents: null,
      },
      notes: ["Screenshot <cropped>"],
    });
    const text = renderSummary(input(v)).text;
    expect(text).toContain("Paid by Alex, Mei. Shared by percent between Alex, Mei, Mum, Dad.");
    expect(text).toContain("&lt;b&gt;Cafe &amp; Co&lt;/b&gt;");
    expect(text).toContain("Screenshot &lt;cropped&gt;");
    expect(text).not.toContain("<b>Cafe");
  });

  it("shows totals per currency", () => {
    const text = renderSummary(input(view([row(1), row(2, { currency: "CHF" })]))).text;
    expect(text).toContain("€10.01");
    expect(text).toContain("CHF 10.02");
  });

  it("falls back for a person it does not know", () => {
    const v = view([row(1)], {
      batch: { payerIds: ["ghost"], includePayers: false, mode: "equal", percents: null },
    });
    const text = renderSummary(input(v)).text;
    expect(text).toContain("Paid by Someone");
    expect(text).toContain("Pick who paid.");
  });
});

describe("the 4096 character cap", () => {
  const long = (n: number) => "x".repeat(n);
  it("never exceeds the cap, whatever is in the rows", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            merchant: fc.string({ maxLength: 400 }),
            label: fc.string({ maxLength: 200 }),
            dup: fc.boolean(),
            included: fc.boolean(),
            amount: fc.integer({ min: 1, max: 99_999_999 }),
            note: fc.string({ maxLength: 300 }),
          }),
          { minLength: 0, maxLength: 60 },
        ),
        (specs) => {
          const rows = specs.map((spec, i) =>
            row(i, {
              merchant: spec.merchant || null,
              amountMinor: spec.amount,
              included: spec.included,
              split: i % 3 === 0 ? { members: ["u-mei", "u-mum", "u-dad"] } : null,
              fieldStates: i % 4 === 0 ? { category: "guessed" } : {},
              duplicateOf: spec.dup
                ? { kind: "draft", id: "d", importId: null, label: spec.label }
                : null,
            }),
          );
          const v = view(rows, { notes: specs.map((s) => s.note) });
          expect(renderSummary(input(v)).text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
          for (let i = 0; i < Math.min(rows.length, 4); i += 1) {
            expect(renderRowEditor(input(v), i).text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("gives way to a pointer to the app when the rows do not all fit", () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(i, {
        merchant: long(60),
        duplicateOf: { kind: "draft", id: "d", importId: null, label: long(80) },
        split: { members: ["u-mei", "u-mum", "u-dad"] },
      }),
    );
    const text = renderSummary(input(view(rows))).text;
    expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(text).toMatch(/\.\.\.and \d+ more\. Open in app to see them\./);
    expect(text).toContain("Adding 60 of 60 rows:");
  });

  it("hard-truncates in the worst case rather than send a message Telegram would refuse", () => {
    const notes = Array.from({ length: 2 }, () => long(1000));
    const rows = [row(1, { merchant: long(10_000) })];
    expect(renderSummary(input(view(rows, { notes }))).text.length).toBeLessThanOrEqual(
      MESSAGE_LIMIT,
    );
    const huge = Array.from({ length: 60 }, (_, i) => row(i));
    const tiny = renderSummary({
      ...input(view(huge)),
      members: members.map((m) => ({ ...m, displayName: long(2000) })),
    });
    expect(tiny.text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });
});

describe("the row editor", () => {
  const v = view([
    row(1),
    row(2, { included: false, split: { members: ["u-mei", "u-dad"] } }),
    row(3, {
      split: {
        mode: "percent",
        members: ["u-mei", "u-mum"],
        percents: { "u-mei": 6000, "u-mum": 4000 },
      },
    }),
  ]);

  it("shows the row with toggles for members, split mode, categories, payers, include and navigation", () => {
    const message = renderRowEditor(input(v), 0);
    expect(message.text).toContain("<b>Row 1 of 3</b>");
    expect(message.text).toContain("Shop 1, €10.01, Food, 3 Nov 2026");
    expect(message.text).toContain("Shared equally between Mei, Mum, Dad.");
    expect(labels(message)).toEqual([
      "Included in import",
      "✗ Alex",
      "✓ Mei",
      "✓ Mum",
      "✓ Dad",
      "● Equal",
      "Percent",
      "● Food",
      "Transport",
      "Stay",
      "Sightseeing",
      "Shopping",
      "Other",
      "💳 Alex",
      "· Mei",
      "· Mum",
      "· Dad",
      "Summary",
      "Next ›",
    ]);
  });

  it("has Prev and Next in the middle, and offers to include an unticked row", () => {
    const message = renderRowEditor(input(v), 1);
    expect(labels(message)).toContain("Not included - tap to include");
    expect(labels(message).slice(-3)).toEqual(["‹ Prev", "Summary", "Next ›"]);
    expect(
      renderRowEditor(input(v), 2)
        .keyboard.at(-1)
        ?.map((b) => b.text),
    ).toEqual(["‹ Prev", "Summary"]);
  });

  it("offers 5% buttons and the typing hint in percent mode", () => {
    const message = renderRowEditor(input(v), 2);
    expect(message.text).toContain("Shared by percent: Mei 60%, Mum 40%.");
    expect(message.text).toContain("reply to this message with percentages");
    expect(labels(message)).toEqual(
      expect.arrayContaining(["Mei -5%", "Mei +5%", "Mum -5%", "Mum +5%", "● Percent"]),
    );
  });

  it("says what is wrong with a split that does not add up", () => {
    const bad = view([
      row(1, {
        split: {
          mode: "percent",
          members: ["u-mei", "u-mum"],
          percents: { "u-mei": 6000, "u-mum": 3000 },
        },
      }),
    ]);
    expect(renderRowEditor(input(bad), 0).text).toContain("Percentages add up to 90.00%, not 100%");
  });

  it("clamps the row to the draft, and falls back to the summary with no rows", () => {
    expect(renderRowEditor(input(v), 99).text).toContain("Row 3 of 3");
    expect(renderRowEditor(input(v), -4).text).toContain("Row 1 of 3");
    expect(renderRowEditor(input(view([])), 0).text).toContain("Draft from your screenshot");
  });

  it("shows an unknown date and merchant plainly", () => {
    const message = renderRowEditor(input(view([row(1, { merchant: null, spentOn: null })])), 0);
    expect(message.text).toContain("unknown, €10.01, Food");
    expect(message.text).not.toContain("2026");
  });
});

describe("closed drafts", () => {
  const expense = (id: string, over: Partial<StoredExpense> = {}): StoredExpense => ({
    id,
    description: `Item ${id}`,
    category: "food",
    spentOn: "2026-11-03",
    amountMinor: 1250,
    currency: "EUR",
    billedAmountMinor: null,
    billedCurrency: null,
    rate: null,
    rateCurrency: null,
    splitMethod: "equal",
    payers: [],
    shares: [],
    createdBy: "u-alex",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    deletedBy: null,
    ...over,
  });

  it("shows the result with an Undo button", () => {
    const v = view([], { status: "confirmed", expenses: [expense("1"), expense("2")] });
    const message = renderDraft(input(v), { kind: "summary" });
    expect(message.text).toContain("Added 2 expenses");
    expect(message.text).toContain("Item 1, €12.50");
    expect(labels(message)).toEqual(["Undo", "Open in app"]);
    const open = buttons(message).find((b) => b.text === "Open in app");
    expect(open?.web_app?.url).toBe(
      `https://app.test/signin?next=${encodeURIComponent("/expenses")}`,
    );
    expect(
      renderConfirmed(input(view([], { status: "confirmed", expenses: [expense("1")] }))).text,
    ).toContain("Added 1 expense<");
  });

  it("shows undone, discarded and expired drafts with no buttons", () => {
    const undone = renderDraft(
      input(view([], { status: "undone", expenses: [expense("1"), expense("2")] })),
      { kind: "summary" },
    );
    expect(undone.text).toBe("Undone. 2 expenses removed from the ledger.");
    expect(
      renderDraft(input(view([], { status: "undone", expenses: [expense("1")] })), {
        kind: "summary",
      }).text,
    ).toContain("1 expense removed");
    expect(renderDraft(input(view([], { status: "cancelled" })), { kind: "summary" })).toEqual({
      text: "Discarded. Nothing was added.",
      keyboard: [],
    });
    expect(renderDraft(input(view([], { status: "expired" })), { kind: "summary" }).text).toContain(
      "expired",
    );
  });

  it("renders the right screen for an open draft", () => {
    expect(renderDraft(input(view([row(1)])), { kind: "row", index: 0 }).text).toContain(
      "Row 1 of 1",
    );
    expect(renderDraft(input(view([row(1)])), { kind: "summary" }).text).toContain("Draft from");
  });

  it("copes with an unusual currency or deleted expenses in a result", () => {
    const v = view([], {
      status: "confirmed",
      expenses: [expense("1", { currency: "XXX" }), expense("2", { deletedAt: new Date() })],
    });
    const text = renderConfirmed(input(v)).text;
    expect(text).toContain("1250 XXX");
    expect(text).toContain("Added 1 expense<");
  });
});
