import { describe, expect, it } from "vitest";
import { todayIn } from "@/lib/ledger";
import {
  addDays,
  dayTiming,
  daysBetween,
  daysToShow,
  enumerateDays,
  isValidTimeZone,
  MAX_DAYS_SHOWN,
  resolveTripRange,
} from "./trip";

describe("calendar day arithmetic", () => {
  it("adds days across month, year and leap boundaries without drifting", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("does not skip or repeat a day when Europe changes its clocks", () => {
    // Clocks go back on 2026-10-25 (Europe) and forward on 2026-03-29.
    expect(enumerateDays("2026-10-24", "2026-10-27")).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);
    expect(enumerateDays("2026-03-28", "2026-03-30")).toHaveLength(3);
    expect(daysBetween("2026-10-24", "2026-10-27")).toBe(3);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("enumerates inclusively and returns nothing for a backwards range", () => {
    expect(enumerateDays("2026-11-03", "2026-11-03")).toEqual(["2026-11-03"]);
    expect(enumerateDays("2026-11-04", "2026-11-03")).toEqual([]);
  });
});

describe("today in the trip's time zone", () => {
  // 2026-11-07 23:30 UTC is already the 8th in Zurich (UTC+1) and Singapore (UTC+8).
  const lateEvening = new Date("2026-11-07T23:30:00Z");

  it("is the calendar day where the trip is, not where the server is", () => {
    expect(todayIn(lateEvening, "UTC")).toBe("2026-11-07");
    expect(todayIn(lateEvening, "Europe/Zurich")).toBe("2026-11-08");
    expect(todayIn(lateEvening, "Asia/Singapore")).toBe("2026-11-08");
    expect(todayIn(lateEvening, "America/New_York")).toBe("2026-11-07");
  });

  it("rolls over at local midnight, including on the day the clocks change", () => {
    // Summer time ends 2026-10-25 at 03:00 local (01:00 UTC).
    expect(todayIn(new Date("2026-10-24T21:59:59Z"), "Europe/Zurich")).toBe("2026-10-24");
    expect(todayIn(new Date("2026-10-24T22:00:00Z"), "Europe/Zurich")).toBe("2026-10-25");
    expect(todayIn(new Date("2026-10-25T22:59:59Z"), "Europe/Zurich")).toBe("2026-10-25");
    expect(todayIn(new Date("2026-10-25T23:00:00Z"), "Europe/Zurich")).toBe("2026-10-26");
  });

  it("classifies days around today", () => {
    expect(dayTiming("2026-11-07", "2026-11-08")).toBe("past");
    expect(dayTiming("2026-11-08", "2026-11-08")).toBe("today");
    expect(dayTiming("2026-11-09", "2026-11-08")).toBe("future");
  });
});

describe("isValidTimeZone", () => {
  it.each(["Europe/Zurich", "Asia/Singapore", "UTC"])("accepts %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });
  it.each(["", "Mars/Olympus", "not a zone", 5, null])("rejects %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

describe("resolveTripRange", () => {
  const today = "2026-11-08";

  it("uses the trip's own dates when they are set", () => {
    expect(
      resolveTripRange({
        tripStart: "2026-11-01",
        tripEnd: "2026-11-14",
        activityDays: ["2026-11-03"],
        today,
      }),
    ).toEqual({ start: "2026-11-01", end: "2026-11-14" });
  });

  it("stretches to cover an expense dated outside the trip so totals still match the ledger", () => {
    expect(
      resolveTripRange({
        tripStart: "2026-11-03",
        tripEnd: "2026-11-05",
        activityDays: ["2026-10-30", "2026-11-09"],
        today,
      }),
    ).toEqual({ start: "2026-10-30", end: "2026-11-09" });
  });

  it("falls back to the days with expenses, running up to today while the trip is under way", () => {
    expect(
      resolveTripRange({
        tripStart: null,
        tripEnd: null,
        activityDays: ["2026-11-06", "2026-11-03"],
        today,
      }),
    ).toEqual({ start: "2026-11-03", end: "2026-11-08" });
  });

  it("does not run past the last expense when every expense is still to come", () => {
    expect(
      resolveTripRange({
        tripStart: null,
        tripEnd: null,
        activityDays: ["2026-11-20", "2026-11-22"],
        today,
      }),
    ).toEqual({ start: "2026-11-20", end: "2026-11-22" });
  });

  it("is just today when there is nothing at all", () => {
    expect(resolveTripRange({ tripStart: null, tripEnd: null, activityDays: [], today })).toEqual({
      start: today,
      end: today,
    });
  });

  it("keeps the end when only a start is known and today is earlier", () => {
    expect(
      resolveTripRange({ tripStart: "2026-12-01", tripEnd: null, activityDays: [], today }),
    ).toEqual({ start: "2026-12-01", end: "2026-12-01" });
  });
});

describe("daysToShow", () => {
  it("lists every calendar day of a normal range, empty days included", () => {
    expect(daysToShow({ start: "2026-11-01", end: "2026-11-04" }, ["2026-11-02"])).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
  });

  it("lists only the days with activity when the range is enormous", () => {
    const shown = daysToShow({ start: "2000-01-01", end: "2026-11-04" }, [
      "2026-11-04",
      "2000-01-01",
      "2026-11-04",
    ]);
    expect(shown).toEqual(["2000-01-01", "2026-11-04"]);
    expect(MAX_DAYS_SHOWN).toBeGreaterThan(366);
  });
});
