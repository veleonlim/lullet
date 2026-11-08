import { describe, expect, it } from "vitest";
import {
  applies,
  checkSplit,
  errorFor,
  initialSplitState,
  readSplitState,
  startEditing,
  stepAfter,
  toFormValues,
  toggled,
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

const [A, B, C, D] = ["a", "b", "c", "d"] as const;
const memberIds = [A, B, C, D];
const today = "2026-11-08";
const input = { memberIds, today };

/** Alex paid S$100 for the four of them, equally: the smallest valid expense. */
function base(): SplitState {
  return withDate(
    withAmount(withTitle(initialSplitState({ userId: A, memberIds }), "Dinner"), 10000, "SGD"),
    today,
  );
}

describe("a new flow", () => {
  it("starts with the sender paying, everyone sharing equally, in SGD", () => {
    const state = initialSplitState({ userId: B, memberIds });
    expect(state).toMatchObject({
      payers: [B],
      sharers: memberIds,
      method: "equal",
      currency: "SGD",
      category: "food",
      title: null,
      amountMinor: null,
      editing: false,
    });
  });

  it("survives the round trip through the database", () => {
    const state = base();
    expect(readSplitState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("is rejected when the stored state is damaged", () => {
    expect(readSplitState({ ...base(), currency: "XXX" })).toBeNull();
    expect(readSplitState({ ...base(), method: "shares" })).toBeNull();
    expect(readSplitState({ ...base(), amountMinor: -5 })).toBeNull();
    expect(readSplitState(null)).toBeNull();
  });
});

describe("which question comes next", () => {
  it("asks every question in order for a one payer, equal split", () => {
    const state = base();
    expect(stepAfter(state, "title")).toBe("amount");
    expect(stepAfter(state, "amount")).toBe("payers");
    expect(stepAfter(state, "payers")).toBe("sharers");
    expect(stepAfter(state, "sharers")).toBe("method");
    expect(stepAfter(state, "method")).toBe("date");
    expect(stepAfter(state, "date")).toBe("category");
    expect(stepAfter(state, "category")).toBe("summary");
  });

  it("asks what each payer paid only when two or more paid", () => {
    const two = withPayers(base(), [A, B]);
    expect(applies(two, "payer_amounts")).toBe(true);
    expect(stepAfter(two, "payers")).toBe("payer_amounts");
    expect(stepAfter(two, "payer_amounts")).toBe("sharers");
    expect(applies(base(), "payer_amounts")).toBe(false);
  });

  it("asks for the numbers only for percent and exact, and skips the method for one sharer", () => {
    const percent = withMethod(base(), "percent");
    expect(stepAfter(percent, "method")).toBe("values");
    expect(stepAfter(percent, "values")).toBe("date");
    expect(stepAfter(withMethod(base(), "exact"), "method")).toBe("values");
    expect(stepAfter(base(), "method")).toBe("date");

    const alone = withSharers(percent, [A]);
    expect(alone.method).toBe("equal");
    expect(stepAfter(alone, "sharers")).toBe("date");
    expect(applies(alone, "method")).toBe(false);
  });

  it("goes back to the summary after changing one answer", () => {
    const editing = startEditing(base());
    expect(stepAfter(editing, "title")).toBe("summary");
    expect(stepAfter(editing, "date")).toBe("summary");
  });

  it("asks only for the answers a change left open while editing", () => {
    const filled = withValues(withMethod(base(), "percent"), { a: 5000, b: 5000 });
    const editing = startEditing(withSharers(filled, [A, B, C]));
    expect(stepAfter(editing, "sharers")).toBe("values");

    const payers = startEditing(withPayers(base(), [A, B]));
    expect(stepAfter(payers, "payers")).toBe("payer_amounts");
    expect(stepAfter(withPayerAmounts(payers, { a: 6000, b: 4000 }), "payer_amounts")).toBe(
      "summary",
    );
  });
});

describe("a change drops the answers it made meaningless", () => {
  const full = withValues(
    withMethod(withPayerAmounts(withPayers(base(), [A, B]), { a: 6000, b: 4000 }), "exact"),
    { a: 2500, b: 2500, c: 2500, d: 2500 },
  );

  it("a new total drops payer amounts and exact amounts, not percentages", () => {
    const changed = withAmount(full, 12000, "SGD");
    expect(changed.payerAmounts).toBeNull();
    expect(changed.values).toBeNull();

    const percent = withValues(withMethod(full, "percent"), { a: 5000, b: 5000 });
    expect(withAmount(percent, 12000, "SGD").values).toEqual({ a: 5000, b: 5000 });
  });

  it("the same total keeps them", () => {
    const same = withAmount(full, 10000, "SGD");
    expect(same.payerAmounts).toEqual({ a: 6000, b: 4000 });
    expect(same.values).toEqual({ a: 2500, b: 2500, c: 2500, d: 2500 });
  });

  it("new payers drop payer amounts; new sharers and a new method drop the numbers", () => {
    expect(withPayers(full, [A, C]).payerAmounts).toBeNull();
    expect(withSharers(full, [A, B]).values).toBeNull();
    expect(withMethod(full, "percent").values).toBeNull();
    expect(withMethod(full, "exact").values).toEqual(full.values);
  });
});

describe("toggling a person", () => {
  it("adds and removes", () => {
    expect(toggled([A], B)).toEqual([A, B]);
    expect(toggled([A, B], A)).toEqual([B]);
    expect(toggled([A], A)).toEqual([]);
  });
});

describe("the finished answers become the web form's expense", () => {
  it("builds an equal expense paid by one person", () => {
    const checked = checkSplit(base(), input);
    expect(checked).toMatchObject({
      ok: true,
      expense: {
        description: "Dinner",
        amountMinor: 10000,
        currency: "SGD",
        spentOn: today,
        category: "food",
        splitMethod: "equal",
        payers: [{ userId: A, amountMinor: 10000 }],
      },
    });
    if (checked.ok) {
      expect(checked.expense.shares.map((s) => s.amountMinor)).toEqual([2500, 2500, 2500, 2500]);
    }
  });

  it("splits by percent in basis points, with the last cent by largest remainder", () => {
    const state = withValues(withMethod(withSharers(base(), [A, B, C]), "percent"), {
      a: 3333,
      b: 3333,
      c: 3334,
    });
    const checked = checkSplit(withAmount(state, 10000, "SGD"), input);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.expense.splitMethod).toBe("percent");
      expect(checked.expense.shares).toEqual([
        { userId: A, amountMinor: 3333, weight: 3333 },
        { userId: B, amountMinor: 3333, weight: 3333 },
        { userId: C, amountMinor: 3334, weight: 3334 },
      ]);
    }
  });

  it("splits by exact amounts and records several payers", () => {
    const state = withValues(withMethod(withSharers(base(), [A, B]), "exact"), {
      a: 7000,
      b: 3000,
    });
    const paid = withPayerAmounts(withPayers(state, [A, B]), { a: 5000, b: 5000 });
    const checked = checkSplit(paid, input);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.expense.payers).toEqual([
        { userId: A, amountMinor: 5000 },
        { userId: B, amountMinor: 5000 },
      ]);
      expect(checked.expense.shares.map((s) => s.amountMinor)).toEqual([7000, 3000]);
    }
  });

  it("keeps a foreign currency as typed", () => {
    const checked = checkSplit(withAmount(base(), 4850, "EUR"), input);
    expect(checked).toMatchObject({ ok: true, expense: { amountMinor: 4850, currency: "EUR" } });
  });

  it("reports what is wrong with the numbers, by field", () => {
    const badPayers = withPayerAmounts(withPayers(base(), [A, B]), { a: 5000, b: 4000 });
    const payers = checkSplit(badPayers, input);
    expect(payers.ok).toBe(false);
    if (!payers.ok)
      expect(errorFor(payers.errors, "payers")).toContain("Payments add up to S$90.00");

    const badSplit = withValues(withMethod(withSharers(base(), [A, B]), "exact"), {
      a: 5000,
      b: 4000,
    });
    const split = checkSplit(badSplit, input);
    expect(split.ok).toBe(false);
    if (!split.ok) {
      expect(errorFor(split.errors, "split")).toContain("Amounts add up to S$90.00");
      expect(errorFor(split.errors, "payers")).toBeNull();
    }
  });

  it("asks for what is still missing", () => {
    const empty = checkSplit(initialSplitState({ userId: A, memberIds }), input);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(errorFor(empty.errors, "description")).toBeTruthy();
      expect(errorFor(empty.errors, "amount")).toBeTruthy();
    }
  });

  it("fills a stand-in date and formats numbers the way the form reads them", () => {
    const state = withValues(withMethod(base(), "percent"), { a: 3333, b: 6667 });
    const form = toFormValues({ ...state, date: null, sharers: [A, B] }, input);
    expect(form.spentOn).toBe(today);
    expect(form.split.mode).toBe("percent");
    expect(form.split.members.find((m) => m.userId === A)?.value).toBe("33.33");
    expect(form.amount).toBe("100.00");
    const exact = toFormValues(
      withValues(withMethod(withSharers(base(), [A, B]), "exact"), { a: 7050, b: 2950 }),
      input,
    );
    expect(exact.split.members.find((m) => m.userId === A)?.value).toBe("70.50");
  });
});
