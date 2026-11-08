import { describe, expect, it } from "vitest";
import type { BatchSplit } from "@/lib/import/split";
import { EMPTY_PLAN } from "./caption";
import { applyCaptionPlan } from "./plan";

const order = ["a", "b", "c", "d"];
const batch: BatchSplit = { payerIds: ["a"], includePayers: false, mode: "equal", percents: null };

describe("applying a caption", () => {
  it("changes nothing for an empty plan", () => {
    expect(applyCaptionPlan(EMPTY_PLAN, batch, order)).toEqual({ batch, rowSplit: null });
  });

  it("sets the payers in the group's order and keeps the old ones when none are valid", () => {
    expect(
      applyCaptionPlan({ ...EMPTY_PLAN, paidBy: ["c", "b"] }, batch, order).batch.payerIds,
    ).toEqual(["b", "c"]);
    expect(
      applyCaptionPlan({ ...EMPTY_PLAN, paidBy: ["zzz"] }, batch, order).batch.payerIds,
    ).toEqual(["a"]);
  });

  it("shares rows between the named people, unless that is already the default", () => {
    expect(
      applyCaptionPlan({ ...EMPTY_PLAN, splitBetween: ["d", "b"] }, batch, order).rowSplit,
    ).toEqual({ members: ["b", "d"] });
    expect(
      applyCaptionPlan({ ...EMPTY_PLAN, splitBetween: ["b", "c", "d"] }, batch, order).rowSplit,
    ).toBeNull();
  });

  it("leaves people out of the default split", () => {
    expect(applyCaptionPlan({ ...EMPTY_PLAN, exclude: ["d"] }, batch, order).rowSplit).toEqual({
      members: ["b", "c"],
    });
    const paidByMum = applyCaptionPlan(
      { ...EMPTY_PLAN, paidBy: ["c"], exclude: ["a"] },
      batch,
      order,
    );
    expect(paidByMum.rowSplit).toEqual({ members: ["b", "d"] });
  });

  it("ignores an exclusion that would leave nobody", () => {
    expect(
      applyCaptionPlan({ ...EMPTY_PLAN, exclude: ["b", "c", "d"] }, batch, order).rowSplit,
    ).toBeNull();
    expect(
      applyCaptionPlan({ ...EMPTY_PLAN, splitBetween: ["zzz"] }, batch, order).rowSplit,
    ).toBeNull();
  });
});
