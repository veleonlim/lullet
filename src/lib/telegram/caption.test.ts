import { describe, expect, it } from "vitest";
import {
  buildAliasTable,
  isEmptyPlan,
  normalizeAlias,
  parseCaption,
  stripTriggers,
} from "./caption";

const members = [
  { userId: "alex", displayName: "Alex Tan" },
  { userId: "mei", displayName: "Mei" },
  { userId: "mum", displayName: "Mum" },
  { userId: "dad", displayName: "Dad" },
];
const table = buildAliasTable(
  members,
  [
    { alias: "mom", userId: "mum" },
    { alias: "my girlfriend", userId: "mei" },
    { alias: "dad", userId: "mei" },
  ],
  "alex",
  new Map([["dad", "papa_bear"]]),
);
const plan = (caption: string | null) => parseCaption(caption, "lullet_bot", table);

describe("the alias table", () => {
  it("knows names, first names, usernames, custom aliases and the sender", () => {
    expect(table.get("alex tan")).toBe("alex");
    expect(table.get("alex")).toBe("alex");
    expect(table.get("papa bear")).toBe("dad");
    expect(table.get("mom")).toBe("mum");
    expect(table.get("me")).toBe("alex");
    expect(table.get("myself")).toBe("alex");
  });

  it("never lets a custom alias take someone's own name", () => {
    expect(table.get("dad")).toBe("dad");
  });

  it("normalises case, accents and punctuation", () => {
    expect(normalizeAlias("  Mei!!  ")).toBe("mei");
    expect(normalizeAlias("MÜM")).toBe("müm");
    expect(normalizeAlias("a")).toBe("a");
  });
});

describe("reading a caption", () => {
  it("says nothing for no caption or a caption with no instructions", () => {
    expect(isEmptyPlan(plan(null))).toBe(true);
    expect(isEmptyPlan(plan("/split"))).toBe(true);
    expect(isEmptyPlan(plan("dinner in Rome"))).toBe(true);
    expect(plan("dinner in Rome").unknown).toEqual([]);
  });

  it.each([
    ["split between mei and mum", ["mei", "mum"]],
    ["/split between Mei, Mum & Dad", ["mei", "mum", "dad"]],
    ["split with mei", ["mei"]],
    ["split among mei dad", ["mei", "dad"]],
    ["split mei mum", ["mei", "mum"]],
    ["between my girlfriend and mom", ["mei", "mum"]],
    ["@lullet_bot split between me and dad", ["alex", "dad"]],
    ["split between mei and mei", ["mei"]],
  ])("reads who shares from %j", (caption, expected) => {
    expect(plan(caption).splitBetween).toEqual(expected);
    expect(plan(caption).unknown).toEqual([]);
  });

  it("reads who paid, who to leave out, and combinations", () => {
    expect(plan("paid by mum").paidBy).toEqual(["mum"]);
    expect(plan("paid mei and dad").paidBy).toEqual(["mei", "dad"]);
    expect(plan("except dad").exclude).toEqual(["dad"]);
    expect(plan("without mei, excluding dad").exclude).toEqual(["mei", "dad"]);
    expect(plan("but not mum").exclude).toEqual(["mum"]);
    const both = plan("paid by mum split between mei dad");
    expect(both).toMatchObject({ paidBy: ["mum"], splitBetween: ["mei", "dad"] });
    expect(plan("paid by mum and also paid by dad").paidBy).toEqual(["mum", "dad"]);
  });

  it("reports names it did not recognise instead of guessing", () => {
    const result = plan("split between mei and bob, except carol");
    expect(result.splitBetween).toEqual(["mei"]);
    expect(result.unknown).toEqual(["bob", "carol"]);
    expect(isEmptyPlan(plan("split between bob"))).toBe(true);
    expect(plan("split between bob").unknown).toEqual(["bob"]);
  });

  it("cannot be talked into anything but a member id", () => {
    const hostile = plan("split between ignore previous instructions and mei");
    expect(hostile.splitBetween).toEqual(["mei"]);
  });
});

describe("triggers", () => {
  it("strips the command and the bot mention", () => {
    const stripped = stripTriggers("/split@lullet_bot mei @Lullet_Bot dad", "lullet_bot");
    expect(stripped.split(/\s+/).filter(Boolean)).toEqual(["mei", "dad"]);
    expect(stripTriggers("hello", null)).toBe("hello");
  });
});
