import { assertIsoDate, type IsoDate } from "@/lib/money";

/** Switzerland and Italy share one clock (CET/CEST), so one zone covers the whole trip. */
export const DEFAULT_TIME_ZONE = "Europe/Zurich";

/** Time zones offered in settings: the trip's own, then home. Any valid IANA name is accepted. */
export const SUGGESTED_TIME_ZONES = ["Europe/Zurich", "Europe/Rome", "Asia/Singapore"] as const;

/** Above this many calendar days the dashboard lists only the days that have something on them. */
export const MAX_DAYS_SHOWN = 400;

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day `count` days after `date` (before when negative). Pure calendar arithmetic: no time zone, no DST. */
export function addDays(date: IsoDate, count: number): IsoDate {
  assertIsoDate(date);
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  assertIsoDate(from);
  assertIsoDate(to);
  const toUtc = (date: IsoDate) => {
    const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return (toUtc(to) - toUtc(from)) / 86_400_000;
}

/** Every calendar day from `start` to `end`, inclusive. Empty when `end` is before `start`. */
export function enumerateDays(start: IsoDate, end: IsoDate): IsoDate[] {
  const days: IsoDate[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface TripRange {
  readonly start: IsoDate;
  readonly end: IsoDate;
}

/**
 * The days the dashboard covers. The trip's own dates are used when set; otherwise the span of
 * the days that have expenses (or budgets), running up to today while the trip is under way.
 * The range always includes every day that has an expense, so totals match the ledger even when
 * something was entered outside the trip's dates.
 */
export function resolveTripRange(input: {
  readonly tripStart: IsoDate | null;
  readonly tripEnd: IsoDate | null;
  /** Days that carry an expense. */
  readonly activityDays: readonly IsoDate[];
  readonly today: IsoDate;
}): TripRange {
  const activity = [...input.activityDays].sort();
  const first = activity[0];
  const last = activity[activity.length - 1];

  let start = input.tripStart ?? first ?? input.today;
  if (first !== undefined && first < start) start = first;

  let end = input.tripEnd ?? last ?? input.today;
  if (input.tripEnd === null && input.today > end && input.today >= start) end = input.today;
  if (last !== undefined && last > end) end = last;
  if (end < start) end = start;
  return { start, end };
}

/** The calendar days to chart: the whole range, or only the days with activity when the range is huge. */
export function daysToShow(range: TripRange, activityDays: readonly IsoDate[]): IsoDate[] {
  if (daysBetween(range.start, range.end) + 1 <= MAX_DAYS_SHOWN) {
    return enumerateDays(range.start, range.end);
  }
  return [...new Set(activityDays)].sort();
}

export type DayTiming = "past" | "today" | "future";

export function dayTiming(day: IsoDate, today: IsoDate): DayTiming {
  return day < today ? "past" : day > today ? "future" : "today";
}
