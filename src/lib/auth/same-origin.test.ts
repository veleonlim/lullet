import { describe, expect, it } from "vitest";
import { isSameOrigin } from "./same-origin";

const headers = (init: Record<string, string>) => new Headers(init);

describe("isSameOrigin", () => {
  it("accepts a matching Origin and Host", () => {
    expect(
      isSameOrigin(headers({ origin: "https://lullet.example", host: "lullet.example" })),
    ).toBe(true);
  });

  it("prefers X-Forwarded-Host behind a proxy", () => {
    expect(
      isSameOrigin(
        headers({
          origin: "https://lullet.example",
          host: "internal:3000",
          "x-forwarded-host": "lullet.example",
        }),
      ),
    ).toBe(true);
  });

  it("rejects another origin, a malformed origin and an origin with no host to compare", () => {
    expect(isSameOrigin(headers({ origin: "https://evil.example", host: "lullet.example" }))).toBe(
      false,
    );
    expect(isSameOrigin(headers({ origin: "not a url", host: "lullet.example" }))).toBe(false);
    expect(isSameOrigin(headers({ origin: "https://lullet.example" }))).toBe(false);
  });

  it("trusts Sec-Fetch-Site when the browser sends it, even if the Origin is hidden as null", () => {
    expect(isSameOrigin(headers({ "sec-fetch-site": "same-origin", origin: "null" }))).toBe(true);
    expect(isSameOrigin(headers({ "sec-fetch-site": "none" }))).toBe(true);
    expect(
      isSameOrigin(
        headers({
          "sec-fetch-site": "cross-site",
          origin: "https://lullet.example",
          host: "lullet.example",
        }),
      ),
    ).toBe(false);
    expect(isSameOrigin(headers({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("lets requests without an Origin header through (not browser driven)", () => {
    expect(isSameOrigin(headers({ host: "lullet.example" }))).toBe(true);
  });
});
