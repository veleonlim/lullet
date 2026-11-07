/** A calendar day exactly as shown on the receipt, e.g. "2026-11-07". Never shifted by time zone. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, year = "", month = "", day = ""] = match;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    probe.getUTCFullYear() === Number(year) &&
    probe.getUTCMonth() === Number(month) - 1 &&
    probe.getUTCDate() === Number(day)
  );
}

export function assertIsoDate(value: unknown, label = "date"): IsoDate {
  if (!isIsoDate(value)) throw new RangeError(`${label} must be a valid YYYY-MM-DD date`);
  return value;
}
