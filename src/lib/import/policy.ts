/** The numbers that govern the import flow, in one place. */

/** Vercel functions accept request bodies up to 4.5 MB, so uploads stay safely under that. */
export const MAX_UPLOAD_BYTES = 4_000_000;

/** Uploads per person in a rolling day (each costs a model call). Overridable with IMPORT_DAILY_LIMIT. */
export const DEFAULT_DAILY_UPLOAD_LIMIT = 30;

/** How often the stronger model may be asked to read one screenshot again. */
export const MAX_REREADS = 2;

/** An unconfirmed draft is discarded after this long. */
export const DRAFT_TTL_HOURS = 24;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function draftExpiry(from: Date): Date {
  return new Date(from.getTime() + DRAFT_TTL_HOURS * HOUR_MS);
}

export function dailyWindowStart(now: Date): Date {
  return new Date(now.getTime() - DAY_MS);
}

/** The daily limit from the environment, falling back to the default for anything that is not a positive whole number. */
export function dailyUploadLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_UPLOAD_LIMIT;
}
