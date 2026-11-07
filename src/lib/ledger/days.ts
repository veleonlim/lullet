import { assertIsoDate, type IsoDate } from "@/lib/money";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(date: IsoDate): { year: number; month: number; day: number; weekday: number } {
  assertIsoDate(date);
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  // Only the weekday is derived from a Date; the calendar day itself is never shifted.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday };
}

/** "Sat 7 Nov", with the year added when it is not `currentYear`: "Sat 7 Nov 2025". */
export function formatDay(date: IsoDate, currentYear?: number): string {
  const { year, month, day, weekday } = parts(date);
  const base = `${WEEKDAYS[weekday] ?? ""} ${String(day)} ${MONTHS[month - 1] ?? ""}`;
  return currentYear === undefined || year === currentYear ? base : `${base} ${String(year)}`;
}

/** "7 Nov 2026". */
export function formatDate(date: IsoDate): string {
  const { year, month, day } = parts(date);
  return `${String(day)} ${MONTHS[month - 1] ?? ""} ${String(year)}`;
}

/** Today's calendar day for a given instant in the given time zone (UTC when omitted). */
export function todayIn(now: Date, timeZone = "UTC"): IsoDate {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

export interface DayGroup<T> {
  readonly date: IsoDate;
  readonly items: readonly T[];
}

/**
 * Groups items by calendar day, newest day first. Within a day the input order is
 * kept, so callers sort items newest first before grouping.
 */
export function groupByDay<T>(items: readonly T[], dateOf: (item: T) => IsoDate): DayGroup<T>[] {
  const byDay = new Map<IsoDate, T[]>();
  for (const item of items) {
    const date = dateOf(item);
    const bucket = byDay.get(date);
    if (bucket) bucket.push(item);
    else byDay.set(date, [item]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, bucket]) => ({ date, items: bucket }));
}
