import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csvCell", () => {
  it("leaves plain values alone and writes missing ones as empty", () => {
    expect(csvCell("Dinner")).toBe("Dinner");
    expect(csvCell(1234)).toBe("1234");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("Pizza, drinks")).toBe('"Pizza, drinks"');
    expect(csvCell('The "good" one')).toBe('"The ""good"" one"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("writes dates as ISO timestamps", () => {
    expect(csvCell(new Date("2026-11-02T10:30:00Z"))).toBe("2026-11-02T10:30:00.000Z");
  });

  it("defuses text a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1 beer")).toBe("'+1 beer");
    expect(csvCell("@home")).toBe("'@home");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("\tTabbed")).toBe("'\tTabbed");
  });

  it("keeps negative amounts written as text readable as numbers", () => {
    expect(csvCell("-12.30")).toBe("-12.30");
    expect(csvCell("-7")).toBe("-7");
  });
});

describe("toCsv", () => {
  it("writes a byte order mark, a header and CRLF line ends", () => {
    const csv = toCsv(
      ["id", "note"],
      [
        [1, "a,b"],
        [2, null],
      ],
    );
    expect(csv).toBe('﻿id,note\r\n1,"a,b"\r\n2,\r\n');
  });

  it("writes just the header for no rows", () => {
    expect(toCsv(["id"], [])).toBe("﻿id\r\n");
  });
});
