import { describe, expect, it } from "vitest";
import {
  setBatchMode,
  setBatchPercent,
  setRowMode,
  setRowPercent,
  toggleBatchPayer,
  toggleBatchPercentMember,
  toggleRowMember,
} from "./edit-split";
import { resolveSplit, type BatchSplit } from "./split";

const ORDER = ["a", "b", "c", "d"];
const BATCH: BatchSplit = { payerIds: ["a"], includePayers: false, mode: "equal", percents: null };

describe("a row's member chips", () => {
  it("removes B from one row and keeps the others following the batch", () => {
    const override = toggleRowMember(BATCH, null, "b", ORDER);
    expect(override).toEqual({ members: ["c", "d"] });
    expect(resolveSplit(BATCH, override, ORDER)).toMatchObject({ split: { members: ["c", "d"] } });
  });

  it("puts a person back and the override disappears when it matches the batch again", () => {
    const without = toggleRowMember(BATCH, null, "b", ORDER);
    expect(toggleRowMember(BATCH, without, "b", ORDER)).toBeNull();
  });

  it("lets the payer's own share be switched on for just one row", () => {
    expect(toggleRowMember(BATCH, null, "a", ORDER)).toEqual({ members: ["a", "b", "c", "d"] });
  });

  it("can leave a row with nobody, which then cannot be added", () => {
    let override = toggleRowMember(BATCH, null, "b", ORDER);
    override = toggleRowMember(BATCH, override, "c", ORDER);
    override = toggleRowMember(BATCH, override, "d", ORDER);
    expect(override).toEqual({ members: [] });
    expect(resolveSplit(BATCH, override, ORDER).ok).toBe(false);
  });

  it("re-evens the percentages when someone is toggled on a percent row", () => {
    const percent = setRowMode(BATCH, null, "percent", ORDER);
    expect(percent).toEqual({
      mode: "percent",
      members: ["b", "c", "d"],
      percents: { b: 3334, c: 3333, d: 3333 },
    });
    expect(toggleRowMember(BATCH, percent, "d", ORDER)).toEqual({
      mode: "percent",
      members: ["b", "c"],
      percents: { b: 5000, c: 5000 },
    });
    const empty = toggleRowMember(
      BATCH,
      { mode: "percent", members: ["b"], percents: { b: 10000 } },
      "b",
      ORDER,
    );
    expect(empty).toEqual({ mode: "percent", members: [], percents: {} });
  });
});

describe("a row's split mode", () => {
  it("switches to percent with even shares, keeps typed percentages, and back to equal", () => {
    const typed = setRowPercent(BATCH, setRowMode(BATCH, null, "percent", ORDER), "b", 5000, ORDER);
    expect(typed).toEqual({
      mode: "percent",
      members: ["b", "c", "d"],
      percents: { b: 5000, c: 3333, d: 3333 },
    });
    // Switching to percent again keeps what was typed while the people are the same.
    expect(setRowMode(BATCH, typed, "percent", ORDER)).toEqual(typed);
    expect(setRowMode(BATCH, typed, "equal", ORDER)).toBeNull();
  });

  it("keeps an equal row that differs from the batch", () => {
    const row = toggleRowMember(BATCH, null, "b", ORDER);
    expect(setRowMode(BATCH, row, "equal", ORDER)).toEqual({ mode: "equal", members: ["c", "d"] });
  });

  it("starts typing percentages on an equal row", () => {
    expect(setRowPercent(BATCH, null, "c", 6000, ORDER)).toEqual({
      mode: "percent",
      members: ["b", "c", "d"],
      percents: { b: 3334, c: 6000, d: 3333 },
    });
  });
});

describe("the batch", () => {
  it("adds and removes payers but never leaves none", () => {
    const two = toggleBatchPayer(BATCH, "c", ORDER);
    expect(two.payerIds).toEqual(["a", "c"]);
    expect(toggleBatchPayer(two, "a", ORDER).payerIds).toEqual(["c"]);
    const only = toggleBatchPayer(two, "a", ORDER);
    expect(toggleBatchPayer(only, "c", ORDER)).toBe(only);
  });

  it("switches the default split to percentages and back", () => {
    const percent = setBatchMode(BATCH, "percent", ORDER);
    expect(percent).toMatchObject({ mode: "percent", percents: { b: 3334, c: 3333, d: 3333 } });
    expect(setBatchMode(percent, "equal", ORDER)).toEqual(BATCH);
  });

  it("toggles members and types percentages in the batch percent split", () => {
    const percent = setBatchMode(BATCH, "percent", ORDER);
    const dropped = toggleBatchPercentMember(percent, "d", ORDER);
    expect(dropped.percents).toEqual({ b: 5000, c: 5000 });
    expect(setBatchPercent(dropped, "b", 7000).percents).toEqual({ b: 7000, c: 5000 });
    expect(toggleBatchPercentMember(dropped, "d", ORDER).percents).toEqual({
      b: 3334,
      c: 3333,
      d: 3333,
    });
    const none = toggleBatchPercentMember(
      toggleBatchPercentMember(dropped, "b", ORDER),
      "c",
      ORDER,
    );
    expect(none.percents).toEqual({});
    expect(setBatchPercent(BATCH, "b", 100).percents).toEqual({ b: 100 });
  });
});
