import { describe, expect, it } from "vitest";
import { decodeCallback } from "@/lib/telegram/callbacks";
import {
  decodeSplitCallback,
  EDIT_FIELDS,
  encodeSplitCallback,
  isSplitCallback,
  type SplitAction,
} from "./callbacks";

const SECRET = "split-callback-secret-0123456789";
const FLOW = "3f2b8c1e-9d4a-4e6f-8a21-5c7d90b1e234";

const ACTIONS: SplitAction[] = [
  { kind: "currency", index: 0 },
  { kind: "currency", index: 2 },
  { kind: "payer", member: 3 },
  { kind: "payers_done" },
  { kind: "payers_equal" },
  { kind: "sharer", member: 0 },
  { kind: "sharers_done" },
  { kind: "method", method: "equal" },
  { kind: "method", method: "percent" },
  { kind: "method", method: "exact" },
  { kind: "day", day: "today" },
  { kind: "day", day: "yesterday" },
  { kind: "category", index: 5 },
  { kind: "category_skip" },
  { kind: "confirm" },
  { kind: "edit" },
  ...EDIT_FIELDS.map((field): SplitAction => ({ kind: "edit_field", field })),
  { kind: "back" },
  { kind: "cancel" },
];

describe("split button data", () => {
  it.each(ACTIONS)("round trips %j within Telegram's 64 bytes", (action) => {
    const data = encodeSplitCallback(SECRET, FLOW, action);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(isSplitCallback(data)).toBe(true);
    expect(decodeSplitCallback(SECRET, data)).toEqual({ ok: true, flowId: FLOW, action });
  });

  it("refuses data signed with another secret or for another flow", () => {
    const data = encodeSplitCallback(SECRET, FLOW, { kind: "confirm" });
    expect(decodeSplitCallback("another-secret-0123456789abcdef", data)).toEqual({ ok: false });
    const other = encodeSplitCallback(SECRET, "11111111-2222-4333-8444-555555555555", {
      kind: "confirm",
    });
    const forged = `${data.split(":")[0] ?? ""}:${other.split(":")[1] ?? ""}:${data.split(":")[2] ?? ""}`;
    expect(decodeSplitCallback(SECRET, forged)).toEqual({ ok: false });
  });

  it("refuses malformed data", () => {
    const data = encodeSplitCallback(SECRET, FLOW, { kind: "confirm" });
    const [, id = "", nonce = ""] = data.split(":");
    for (const bad of [
      "",
      "w.ok",
      `w.zz:${id}:${nonce}`,
      `w.ok.1:${id}:${nonce}`,
      `w.p:${id}:${nonce}`,
      `w.p.x:${id}:${nonce}`,
      `w.f.99:${id}:${nonce}`,
      `w.m.q:${id}:${nonce}`,
      `x.ok:${id}:${nonce}`,
      `w.ok:${id}:${nonce}:extra`,
      `w.ok:${id}:short`,
      `w.ok:not-an-id:${nonce}`,
    ]) {
      expect(decodeSplitCallback(SECRET, bad)).toEqual({ ok: false });
    }
  });

  it("is told apart from the draft buttons, which cannot read it", () => {
    const data = encodeSplitCallback(SECRET, FLOW, { kind: "confirm" });
    expect(decodeCallback(SECRET, data).ok).toBe(false);
    expect(isSplitCallback("c:abcdefghijklmnopqrstuv:12345678")).toBe(false);
  });
});
