import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_UPLOAD_LIMIT,
  dailyUploadLimit,
  dailyWindowStart,
  draftExpiry,
  retentionCutoff,
} from "./policy";

describe("import policy", () => {
  const now = new Date("2026-11-08T12:00:00Z");

  it("expires a draft 24 hours after it was made", () => {
    expect(draftExpiry(now).toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("keeps originals for 30 days after confirmation", () => {
    expect(retentionCutoff(now).toISOString()).toBe("2026-10-09T12:00:00.000Z");
  });

  it("counts uploads over a rolling day", () => {
    expect(dailyWindowStart(now).toISOString()).toBe("2026-11-07T12:00:00.000Z");
  });

  it("reads the daily limit from the environment or falls back", () => {
    expect(dailyUploadLimit("12")).toBe(12);
    for (const bad of [undefined, "", "0", "-3", "abc", "1.5"]) {
      expect(dailyUploadLimit(bad)).toBe(DEFAULT_DAILY_UPLOAD_LIMIT);
    }
  });
});
