import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./tokens";

describe("tokens", () => {
  it("generates 256 bit url-safe tokens that never repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically to 64 hex characters that do not contain the token", () => {
    const hash = hashToken("secret-secret-secret-secret-secret-1", "token-1");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken("secret-secret-secret-secret-secret-1", "token-1"));
    expect(hash).not.toContain("token-1");
  });

  it("depends on both the secret and the token", () => {
    const base = hashToken("secret-secret-secret-secret-secret-1", "token-1");
    expect(hashToken("secret-secret-secret-secret-secret-2", "token-1")).not.toBe(base);
    expect(hashToken("secret-secret-secret-secret-secret-1", "token-2")).not.toBe(base);
  });
});
