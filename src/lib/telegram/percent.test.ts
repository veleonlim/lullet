import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveSplit, type BatchSplit } from "@/lib/import/split";
import { NUDGE_STEP, nudgeRowPercent, parseTypedPercents } from "./percent";

const order = ["a", "b", "c", "d"];
const batch: BatchSplit = { payerIds: ["a"], includePayers: false, mode: "equal", percents: null };

function percents(override: ReturnType<typeof nudgeRowPercent>) {
  const resolved = resolveSplit(batch, override, order);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.split.basisPoints;
}

describe("nudging a percentage", () => {
  it("moves 5% from the last person to the one nudged, keeping 100%", () => {
    expect(percents(nudgeRowPercent(batch, null, "b", 1, order))).toEqual({
      b: 3834,
      c: 3333,
      d: 2833,
    });
    expect(percents(nudgeRowPercent(batch, null, "b", -1, order))).toEqual({
      b: 2834,
      c: 3333,
      d: 3833,
    });
  });

  it("gives the change to the first person when the last one is nudged", () => {
    expect(percents(nudgeRowPercent(batch, null, "d", 1, order))).toEqual({
      b: 2834,
      c: 3333,
      d: 3833,
    });
  });

  it("stops at 0% and 100%", () => {
    let override = nudgeRowPercent(batch, null, "b", 1, order);
    for (let i = 0; i < 40; i += 1) override = nudgeRowPercent(batch, override, "b", 1, order);
    expect(percents(override)).toMatchObject({ b: 6667, c: 3333, d: 0 });
    for (let i = 0; i < 40; i += 1) override = nudgeRowPercent(batch, override, "b", -1, order);
    const final = percents(override) ?? {};
    expect(final.b).toBe(0);
    expect(Object.values(final).reduce((x, y) => x + y, 0)).toBe(10_000);
  });

  it("does nothing for someone not on the row, or a row of one", () => {
    const only = { mode: "equal" as const, members: ["b"] };
    expect(nudgeRowPercent(batch, only, "b", 1, order)).toMatchObject({ mode: "percent" });
    expect(nudgeRowPercent(batch, null, "a", 1, order)).toMatchObject({ mode: "percent" });
  });

  it("always keeps rows at 100% however it is tapped", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom("b", "c", "d"), fc.constantFrom<1 | -1>(1, -1)), {
          maxLength: 30,
        }),
        (taps) => {
          let override: ReturnType<typeof nudgeRowPercent> = null;
          for (const [who, direction] of taps) {
            override = nudgeRowPercent(batch, override, who, direction, order);
          }
          const points =
            percents(override) ?? percents(nudgeRowPercent(batch, null, "b", 1, order)) ?? {};
          const values = Object.values(points);
          expect(values.reduce((x, y) => x + y, 0)).toBe(10_000);
          expect(values.every((v) => v >= 0 && v <= 10_000)).toBe(true);
          expect(NUDGE_STEP).toBe(500);
        },
      ),
    );
  });
});

describe("typed percentages", () => {
  const people = ["b", "c", "d"];

  it.each([
    ["50 30 20", { b: 5000, c: 3000, d: 2000 }],
    ["50, 30", { b: 5000, c: 3000, d: 2000 }],
    ["50% / 25%", { b: 5000, c: 2500, d: 2500 }],
    ["33.33 33.33 33.34", { b: 3333, c: 3333, d: 3334 }],
    ["33.5 33.5", { b: 3350, c: 3350, d: 3300 }],
    ["60,40", { b: 6000, c: 4000 }],
    ["60/40", { b: 6000, c: 4000 }],
    ["100 0 0", { b: 10_000, c: 0, d: 0 }],
  ])("reads %j", (text, expected) => {
    const who = Object.keys(expected).length === 2 ? ["b", "c"] : people;
    expect(parseTypedPercents(text, who)).toEqual({ ok: true, percents: expected });
  });

  it("treats a comma as a separator, never as a decimal point", () => {
    expect(parseTypedPercents("33,5 33,5", people)).toEqual({
      ok: false,
      message: "Send 3 percentages, one per person in the order shown.",
    });
  });

  it.each([
    ["", "Reply with percentages, like 60 40."],
    ["hello", "Reply with percentages, like 60 40."],
    ["50", "Send 3 percentages, one per person in the order shown."],
    ["10 10 10 10", "Send 3 percentages, one per person in the order shown."],
    ["50 40 20", "The percentages must add up to 100."],
    ["60 60", "The percentages must add up to 100."],
    ["90 20", "The percentages must add up to 100."],
  ])("explains %j", (text, message) => {
    expect(parseTypedPercents(text, people)).toEqual({ ok: false, message });
  });

  it("needs people to give percentages to", () => {
    expect(parseTypedPercents("50 50", [])).toMatchObject({ ok: false });
  });
});
