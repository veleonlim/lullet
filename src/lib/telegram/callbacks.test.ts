import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CALLBACK_DATA_MAX_BYTES,
  decodeCallback,
  encodeCallback,
  longId,
  nonceFor,
  shortId,
  type CallbackAction,
} from "./callbacks";

const SECRET = "callback-test-secret";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const actions: CallbackAction[] = [
  { kind: "confirm" },
  { kind: "cancel" },
  { kind: "undo" },
  { kind: "summary" },
  { kind: "edit", row: 59 },
  { kind: "member", row: 12, member: 3 },
  { kind: "mode", row: 0, mode: "equal" },
  { kind: "mode", row: 0, mode: "percent" },
  { kind: "nudge", row: 7, member: 2, delta: 1 },
  { kind: "nudge", row: 7, member: 2, delta: -1 },
  { kind: "category", row: 1, category: 5 },
  { kind: "payer", row: 1, member: 0 },
  { kind: "include", row: 44 },
];

describe("callback data", () => {
  it.each(actions)("round trips %o within Telegram's 64 byte limit", (action) => {
    const data = encodeCallback(SECRET, ID, action);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    expect(decodeCallback(SECRET, data)).toEqual({ ok: true, importId: ID, action });
  });

  it("carries only the draft id and a nonce, never amounts or names", () => {
    const data = encodeCallback(SECRET, ID, { kind: "confirm" });
    expect(data.split(":")).toEqual(["c", shortId(ID), nonceFor(SECRET, ID)]);
  });

  it("rejects a nonce minted under another secret, or for another draft", () => {
    const data = encodeCallback("another-secret", ID, { kind: "confirm" });
    expect(decodeCallback(SECRET, data)).toEqual({ ok: false, reason: "bad_nonce" });
    const other = encodeCallback(SECRET, "11111111-1111-4111-8111-111111111111", {
      kind: "confirm",
    });
    const swapped = `c:${shortId(ID)}:${other.split(":")[2] ?? ""}`;
    expect(decodeCallback(SECRET, swapped)).toEqual({ ok: false, reason: "bad_nonce" });
  });

  it.each([
    "",
    "c",
    "c:x:y",
    `z:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `c.1:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `e:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `e.x:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `t.1:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `g.1:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `m.1.x:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `n.1.1.x:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `n.1.1:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `i.1.2:${shortId(ID)}:${nonceFor(SECRET, ID)}`,
    `c:${shortId(ID)}:short`,
    `c:${"A".repeat(22)}:${nonceFor(SECRET, ID)}`,
    `c:${shortId(ID)}:${nonceFor(SECRET, ID)}:extra`,
    "c".repeat(100),
  ])("treats %j as malformed", (data) => {
    expect(decodeCallback(SECRET, data)).toMatchObject({ ok: false });
  });

  it("round trips any uuid through the short form", () => {
    fc.assert(
      fc.property(fc.uuid(), (uuid) => {
        const lower = uuid.toLowerCase();
        expect(longId(shortId(lower))).toBe(lower);
        expect(shortId(lower)).toHaveLength(22);
      }),
    );
  });

  it("refuses ids that are not uuids", () => {
    expect(() => shortId("nope")).toThrow();
    expect(longId("nope")).toBeNull();
    expect(longId("A".repeat(21))).toBeNull();
    expect(longId("*".repeat(22))).toBeNull();
  });

  it("refuses to build data that would not fit", () => {
    expect(() =>
      encodeCallback(SECRET, ID, {
        kind: "nudge",
        row: Number.MAX_SAFE_INTEGER,
        member: Number.MAX_SAFE_INTEGER,
        delta: 1,
      }),
    ).toThrow("too long");
  });
});
