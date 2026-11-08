import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "./security-headers";

const asMap = (development: boolean) =>
  new Map(securityHeaders({ development }).map((rule) => [rule.key, rule.value]));

describe("security headers", () => {
  it("sends the full set in production", () => {
    const headers = asMap(false);
    expect([...headers.keys()].sort()).toEqual([
      "Content-Security-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
    ]);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
  });

  it("leaves out the policy and HSTS in development", () => {
    const headers = asMap(true);
    expect(headers.has("Content-Security-Policy")).toBe(false);
    expect(headers.has("Strict-Transport-Security")).toBe(false);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("allows only this site, plus Telegram as a frame parent", () => {
    const policy = contentSecurityPolicy();
    const directives = new Map(
      policy.split("; ").map((part) => [part.split(" ")[0], part] as const),
    );
    expect(directives.get("default-src")).toBe("default-src 'self'");
    expect(directives.get("object-src")).toBe("object-src 'none'");
    expect(directives.get("connect-src")).toBe("connect-src 'self'");
    expect(directives.get("base-uri")).toBe("base-uri 'self'");
    expect(directives.get("form-action")).toBe("form-action 'self'");
    expect(directives.get("frame-ancestors")).toContain("https://web.telegram.org");
    expect(directives.get("script-src")).not.toMatch(/https?:/);
    expect(policy).not.toContain("unsafe-eval");
  });
});
