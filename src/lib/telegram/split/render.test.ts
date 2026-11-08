import { describe, expect, it } from "vitest";
import { decodeSplitCallback } from "./callbacks";
import {
  inGroupOrder,
  renderAdded,
  renderEditMenu,
  renderProblem,
  renderQuestion,
  renderRecap,
  renderSummary,
  type SplitScreenInput,
} from "./render";
import {
  checkSplit,
  initialSplitState,
  withAmount,
  withDate,
  withMethod,
  withPayerAmounts,
  withPayers,
  withSharers,
  withTitle,
  withValues,
  type SplitState,
} from "./state";

const SECRET = "render-secret-0123456789abcdef";
const FLOW = "3f2b8c1e-9d4a-4e6f-8a21-5c7d90b1e234";
const members = [
  { userId: "a", displayName: "Alex" },
  { userId: "b", displayName: "Mei <3" },
  { userId: "c", displayName: "Mum" },
  { userId: "d", displayName: "Dad" },
];
const ids = members.map((m) => m.userId);
const input = (state: SplitState): SplitScreenInput => ({
  flowId: FLOW,
  secret: SECRET,
  state,
  members,
});

const start = () => initialSplitState({ userId: "a", memberIds: ids });
const filled = () =>
  withDate(withAmount(withTitle(start(), "Dinner <b>"), 10000, "EUR"), "2026-11-07");

const labels = (message: { keyboard: { text: string }[][] }) =>
  message.keyboard.map((row) => row.map((b) => b.text));

describe("the questions", () => {
  it("asks for the title with a cancel button", () => {
    const q = renderQuestion(input(start()), "title");
    expect(q.text).toContain("What was it for");
    expect(labels(q)).toEqual([["Cancel"]]);
  });

  it("offers SGD, EUR and CHF and marks the one a bare number will use", () => {
    const q = renderQuestion(input(start()), "amount");
    expect(labels(q)[0]).toEqual(["✓ SGD", "EUR", "CHF"]);
    expect(q.text).toContain("A plain number is in SGD");
    const eur = renderQuestion(input({ ...start(), currency: "EUR" }), "amount");
    expect(labels(eur)[0]).toEqual(["SGD", "✓ EUR", "CHF"]);
  });

  it("shows who is chosen as payer and sharer, two to a row", () => {
    const payers = renderQuestion(input(withPayers(start(), ["a", "c"])), "payers");
    expect(labels(payers)).toEqual([
      ["✓ Alex", "Mei <3"],
      ["✓ Mum", "Dad"],
      ["Done", "Cancel"],
    ]);
    const sharers = renderQuestion(input(withSharers(start(), ["a", "b"])), "sharers");
    expect(labels(sharers)).toEqual([
      ["✓ Alex", "✓ Mei <3"],
      ["Mum", "Dad"],
      ["Done", "Cancel"],
    ]);
  });

  it("asks what each payer paid in the group's order, with the total and an example", () => {
    const state = withPayers(filled(), ["c", "a"]);
    const q = renderQuestion(input(state), "payer_amounts");
    expect(q.text).toContain("The total is €100.00");
    expect(q.text).toContain("Alex, Mum");
    expect(q.text).toContain("<code>10 20</code>");
    expect(labels(q)).toEqual([["Paid equally", "Cancel"]]);
  });

  it("offers the three ways to split", () => {
    expect(labels(renderQuestion(input(start()), "method"))[0]).toEqual([
      "Equally",
      "By percent",
      "Exact amounts",
    ]);
  });

  it("asks for percentages or exact amounts for the people who share", () => {
    const percent = withMethod(withSharers(filled(), ["a", "b"]), "percent");
    const p = renderQuestion(input(percent), "values");
    expect(p.text).toContain("add up to 100");
    expect(p.text).toContain("Alex, Mei &lt;3");
    expect(p.text).toContain("<code>60 40</code>");
    const exact = renderQuestion(input({ ...percent, method: "exact" }), "values");
    expect(exact.text).toContain("add up to €100.00");
    expect(exact.text).toContain("<code>10 20</code>");
  });

  it("offers today and yesterday for the date, and every category plus a skip", () => {
    expect(labels(renderQuestion(input(start()), "date"))[0]).toEqual(["Today", "Yesterday"]);
    const q = renderQuestion(input(start()), "category");
    expect(labels(q)).toEqual([
      ["Food", "Transport", "Stay"],
      ["Sightseeing", "Shopping", "Other"],
      ["Skip (Food)", "Cancel"],
    ]);
    const keep = renderQuestion(input({ ...start(), category: "stay" }), "category");
    expect(keep.text).toContain("keep Stay");
  });

  it("puts only valid, signed, short button data on every button", () => {
    const states = [start(), withPayers(filled(), ["a", "b"]), withMethod(filled(), "percent")];
    for (const state of states) {
      for (const step of [
        "title",
        "amount",
        "payers",
        "payer_amounts",
        "sharers",
        "method",
        "values",
        "date",
        "category",
      ] as const) {
        const q = renderQuestion(input(state), step);
        for (const button of q.keyboard.flat()) {
          const data = "callback_data" in button ? button.callback_data : "";
          expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
          expect(decodeSplitCallback(SECRET, data)).toMatchObject({
            ok: true,
            flowId: FLOW,
          });
        }
      }
    }
  });

  it("has no question for the summary or the menu", () => {
    expect(() => renderQuestion(input(start()), "summary")).toThrow();
    expect(() => renderQuestion(input(start()), "menu")).toThrow();
  });
});

describe("recaps", () => {
  it("turns an answered question into one escaped line", () => {
    const state = withPayerAmounts(
      withPayers(withValues(withMethod(filled(), "percent"), { a: 6000, b: 4000 }), ["a", "b"]),
      { a: 7000, b: 3000 },
    );
    const recap = (step: Parameters<typeof renderRecap>[1]) => renderRecap(input(state), step);
    expect(recap("title")).toBe("Expense: <b>Dinner &lt;b&gt;</b>");
    expect(recap("amount")).toBe("Amount: <b>€100.00</b>");
    expect(recap("payers")).toBe("Paid by: <b>Alex, Mei &lt;3</b>");
    expect(recap("payer_amounts")).toBe("Paid: Alex €70.00, Mei &lt;3 €30.00");
    expect(recap("sharers")).toBe("Shared by: <b>Alex, Mei &lt;3, Mum, Dad</b>");
    expect(recap("method")).toBe("Split: <b>by percent</b>");
    expect(recap("values")).toBe("Split by percent: Alex 60%, Mei &lt;3 40%");
    expect(recap("date")).toBe("Date: <b>Sat 7 Nov</b>");
    expect(recap("category")).toBe("Category: <b>Food</b>");
    expect(recap("summary")).toBeNull();
    expect(recap("menu")).toBeNull();
  });

  it("describes exact amounts and an equal split", () => {
    const exact = withValues(withMethod(filled(), "exact"), { a: 7000, b: 3000 });
    expect(renderRecap(input(exact), "values")).toBe(
      "Split by exact amounts: Alex €70.00, Mei &lt;3 €30.00",
    );
    expect(renderRecap(input(filled()), "method")).toBe("Split: <b>equally</b>");
  });
});

describe("the summary", () => {
  const expenseOf = (state: SplitState) => {
    const checked = checkSplit(state, { memberIds: ids, today: "2026-11-08" });
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    return checked.expense;
  };

  it("shows the expense, the exchange rate note for a foreign currency, and Confirm, Edit, Cancel", () => {
    const message = renderSummary(input(filled()), expenseOf(filled()));
    expect(message.text).toContain("<b>Check this expense</b>");
    expect(message.text).toContain("<b>Dinner &lt;b&gt;</b>");
    expect(message.text).toContain("€100.00 on Sat 7 Nov, Food");
    expect(message.text).toContain("Paid by Alex");
    expect(message.text).toContain(
      "Split equally: Alex €25.00, Mei &lt;3 €25.00, Mum €25.00, Dad €25.00",
    );
    expect(message.text).toContain("exchange rate");
    expect(labels(message)).toEqual([["Confirm", "Edit", "Cancel"]]);
  });

  it("shows payers' amounts, percentages and no exchange rate note for SGD", () => {
    const state = withPayerAmounts(
      withPayers(
        withValues(
          withMethod(withSharers(withAmount(filled(), 10000, "SGD"), ["a", "b"]), "percent"),
          { a: 6000, b: 4000 },
        ),
        ["a", "b"],
      ),
      { a: 5000, b: 5000 },
    );
    const message = renderSummary(input(state), expenseOf(state));
    expect(message.text).toContain("Paid by Alex S$50.00, Mei &lt;3 S$50.00");
    expect(message.text).toContain("Split by percent: Alex 60% S$60.00, Mei &lt;3 40% S$40.00");
    expect(message.text).not.toContain("exchange rate");
  });

  it("says 'shared by' when one person has the whole expense", () => {
    const state = withSharers(filled(), ["c"]);
    expect(renderSummary(input(state), expenseOf(state)).text).toContain("Shared by Mum €100.00");
  });

  it("becomes the added message with a link into the app", () => {
    const added = renderAdded(input(filled()), expenseOf(filled()), {
      appUrl: "https://lullet.test",
      expenseId: "e-1",
    });
    expect(added.text.startsWith("<b>Added</b>")).toBe(true);
    const link = added.keyboard[0]?.[0];
    expect(link && "web_app" in link ? link.web_app.url : null).toBe(
      "https://lullet.test/signin?next=%2Fexpenses%2Fe-1",
    );
  });

  it("shows a problem with Edit and Cancel", () => {
    const message = renderProblem(input(filled()), "Amounts add up to <wrong>");
    expect(message.text).toContain("Amounts add up to &lt;wrong&gt;");
    expect(labels(message)).toEqual([["Edit", "Cancel"]]);
  });
});

describe("the edit menu", () => {
  it("lists every answer, and the split only when more than one person shares", () => {
    expect(labels(renderEditMenu(input(filled())))).toEqual([
      ["Title", "Amount"],
      ["Paid by", "Shared by"],
      ["Split", "Date"],
      ["Category"],
      ["Back"],
    ]);
    const alone = labels(renderEditMenu(input(withSharers(filled(), ["a"])))).flat();
    expect(alone).not.toContain("Split");
  });
});

describe("group order", () => {
  it("lists people the way amounts are typed", () => {
    expect(inGroupOrder(members, ["d", "a", "x"])).toEqual(["a", "d"]);
  });
});
