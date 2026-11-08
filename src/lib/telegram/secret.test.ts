import { describe, expect, it } from "vitest";
import { SECRET_HEADER, secretsMatch } from "./secret";

describe("the webhook secret", () => {
  it("accepts only the exact secret", () => {
    expect(secretsMatch("abc-123_XYZ", "abc-123_XYZ")).toBe(true);
    expect(secretsMatch("abc-123_XYZ", "abc-123_XYz")).toBe(false);
    expect(secretsMatch("abc", "abc-123_XYZ")).toBe(false);
    expect(secretsMatch("abc-123_XYZ-and-more", "abc-123_XYZ")).toBe(false);
  });

  it("refuses a missing or empty secret, even against an empty configuration", () => {
    expect(secretsMatch(null, "abc")).toBe(false);
    expect(secretsMatch("", "abc")).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("abc", "")).toBe(false);
  });

  it("uses the header name Telegram documents", () => {
    expect(SECRET_HEADER).toBe("x-telegram-bot-api-secret-token");
  });
});
