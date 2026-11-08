import { describe, expect, it } from "vitest";
import { clip, escapeHtml } from "./html";

describe("html helpers", () => {
  it("escapes what Telegram would read as markup", () => {
    expect(escapeHtml("<b>Tom & Jerry's</b>")).toBe("&lt;b&gt;Tom &amp; Jerry's&lt;/b&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("clips to a length, flattening whitespace", () => {
    expect(clip("  a \n  b  ", 10)).toBe("a b");
    expect(clip("abcdefghij", 8)).toBe("abcde...");
    expect(clip("abcdefghij", 10)).toBe("abcdefghij");
    expect(clip("abc", 2)).toBe("...");
  });
});
