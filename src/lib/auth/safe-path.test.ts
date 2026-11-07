import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-path";

describe("safeNextPath", () => {
  it.each(["/", "/members", "/expenses/new?currency=EUR", "/a/b#c"])("keeps %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    "javascript:alert(1)",
    "members",
    "",
    "/ok\nSet-Cookie: x=1",
    "/ok\\..\\x",
    undefined,
    null,
    42,
  ])("replaces %j with the fallback", (value) => {
    expect(safeNextPath(value)).toBe("/");
    expect(safeNextPath(value, "/home")).toBe("/home");
  });
});
