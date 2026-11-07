import type { IsoDate } from "@/lib/money";

const DAY_MS = 86_400_000;

/** Whole days between two calendar days, always positive. */
export function dayDistance(a: IsoDate, b: IsoDate): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  return Math.abs(Math.round((left - right) / DAY_MS));
}

/** The calendar day `days` after (or before, if negative) `date`. */
export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
