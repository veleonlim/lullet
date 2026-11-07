import { describe, expect, it } from "vitest";
import { buildInitData, TEST_BOT_TOKEN } from "@/test-support/telegram";
import { INIT_DATA_MAX_AGE_SECONDS } from "./config";
import { verifyInitData } from "./init-data";

const now = new Date("2026-11-07T12:00:00Z");
const secondsAgo = (seconds: number) => new Date(now.getTime() - seconds * 1000);

function good(overrides: Partial<Parameters<typeof buildInitData>[0]> = {}) {
  return buildInitData({ userId: 424242, authDate: secondsAgo(30), ...overrides });
}

describe("verifyInitData", () => {
  it("accepts correctly signed, fresh init data and returns the Telegram user", () => {
    const result = verifyInitData(good({ firstName: "Mei", username: "mei" }), TEST_BOT_TOKEN, {
      now,
    });
    expect(result).toEqual({
      ok: true,
      authDate: secondsAgo(30),
      user: { id: 424242, firstName: "Mei", lastName: undefined, username: "mei" },
    });
  });

  it("matches a vector computed outside this code base", () => {
    // Produced by an independent Python implementation of Telegram's documented algorithm
    // (hashlib/hmac) with the test bot token, not by buildInitData or verifyInitData.
    const initData =
      "auth_date=1762516800&query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A424242%2C%22first_name%22%3A%22Mei%22%2C%22username%22%3A%22mei%22%7D&hash=45c40ddfcaa903705d3390a643df89a4da48bf7e1237d1eb9a1cc4e0ce8c457e";
    const shortlyAfter = new Date(1762516800_000 + 10_000);
    expect(verifyInitData(initData, TEST_BOT_TOKEN, { now: shortlyAfter })).toEqual({
      ok: true,
      authDate: new Date(1762516800_000),
      user: { id: 424242, firstName: "Mei", lastName: undefined, username: "mei" },
    });
    // One changed character in the hash is a different signature.
    const nearMiss = initData.replace(/7e$/, "7f");
    expect(verifyInitData(nearMiss, TEST_BOT_TOKEN, { now: shortlyAfter })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature made with a different bot token", () => {
    const initData = good({ botToken: "999999:another-bot" });
    expect(verifyInitData(initData, TEST_BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects tampering with any signed field", () => {
    const params = new URLSearchParams(good());
    params.set("user", JSON.stringify({ id: 1, first_name: "Mallory" }));
    expect(verifyInitData(params.toString(), TEST_BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });

    const extra = new URLSearchParams(good());
    extra.set("start_param", "injected");
    expect(verifyInitData(extra.toString(), TEST_BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a missing, short, uppercase or non-hex hash without throwing", () => {
    const base = new URLSearchParams(good());
    const withoutHash = new URLSearchParams(base);
    withoutHash.delete("hash");
    expect(verifyInitData(withoutHash.toString(), TEST_BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "missing_hash",
    });

    for (const bad of ["", "abc", "z".repeat(64), (base.get("hash") ?? "").toUpperCase()]) {
      const params = new URLSearchParams(base);
      params.set("hash", bad);
      expect(verifyInitData(params.toString(), TEST_BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });

  it("rejects repeated keys, empty input and oversized input", () => {
    expect(verifyInitData(`${good()}&auth_date=1`, TEST_BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyInitData("", TEST_BOT_TOKEN, { now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyInitData("a=".padEnd(5000, "b"), TEST_BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  describe("freshness window", () => {
    it("accepts data right up to the limit and refuses it one second later", () => {
      const atLimit = good({ authDate: secondsAgo(INIT_DATA_MAX_AGE_SECONDS) });
      expect(verifyInitData(atLimit, TEST_BOT_TOKEN, { now }).ok).toBe(true);

      const tooOld = good({ authDate: secondsAgo(INIT_DATA_MAX_AGE_SECONDS + 1) });
      expect(verifyInitData(tooOld, TEST_BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("honours a custom window", () => {
      const initData = good({ authDate: secondsAgo(120) });
      expect(verifyInitData(initData, TEST_BOT_TOKEN, { now, maxAgeSeconds: 60 })).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("tolerates a little clock skew but not a far-future auth_date", () => {
      const slightlyAhead = good({ authDate: new Date(now.getTime() + 30_000) });
      expect(verifyInitData(slightlyAhead, TEST_BOT_TOKEN, { now }).ok).toBe(true);

      const farAhead = good({ authDate: new Date(now.getTime() + 3_600_000) });
      expect(verifyInitData(farAhead, TEST_BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "from_the_future",
      });
    });

    it("requires a numeric auth_date", () => {
      expect(verifyInitData(good({ omitAuthDate: true }), TEST_BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "missing_auth_date",
      });
      expect(
        verifyInitData(good({ extra: { auth_date: "yesterday" } }), TEST_BOT_TOKEN, { now }),
      ).toEqual({ ok: false, reason: "missing_auth_date" });
    });

    it("uses the real clock when none is given", () => {
      const fresh = buildInitData({ userId: 5, authDate: new Date() });
      expect(verifyInitData(fresh, TEST_BOT_TOKEN).ok).toBe(true);
    });
  });

  describe("user payload", () => {
    it.each([
      ["not JSON", "{oops"],
      ["no id", JSON.stringify({ first_name: "X" })],
      ["a string id", JSON.stringify({ id: "12" })],
      ["a negative id", JSON.stringify({ id: -5 })],
      ["a fractional id", JSON.stringify({ id: 1.5 })],
      ["an unsafe id", '{"id":99999999999999999999}'],
      ["a JSON array", "[1]"],
    ])("rejects %s", (_name, userJson) => {
      expect(verifyInitData(good({ userJson }), TEST_BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "missing_user",
      });
    });

    it("requires a user field at all", () => {
      const noUser = buildInitData({ userId: 1, authDate: secondsAgo(1), omitUser: true });
      expect(new URLSearchParams(noUser).has("user")).toBe(false);
      expect(verifyInitData(noUser, TEST_BOT_TOKEN, { now })).toEqual({
        ok: false,
        reason: "missing_user",
      });
    });
  });
});
