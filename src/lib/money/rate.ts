import { minorUnitExponent, type CurrencyCode } from "./currency";
import { MoneyError } from "./errors";
import { divRoundHalfUp, toSafeNumber, type Minor } from "./integer";

/**
 * Exchange rates as exact decimals (an integer numerator over a power of ten),
 * so a rate stored as text in Postgres round-trips without any float error.
 * A rate always means "units of the quote currency per 1 unit of the base".
 */

/** Matches `numeric(20, 10)` in the database. */
export const MAX_RATE_SCALE = 10;
const MAX_RATE_INTEGER_DIGITS = 10;

export interface Rate {
  /** The rate multiplied by 10^scale. Always positive. */
  readonly numerator: bigint;
  readonly scale: number;
}

/** Parses a positive plain decimal such as "1.4344" or "0.9143000000". */
export function parseRate(text: string): Rate {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new MoneyError("invalid_rate", `Not a plain decimal rate: "${text}"`);

  const [, integer = "", fraction = ""] = match;
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > MAX_RATE_SCALE) {
    throw new MoneyError(
      "invalid_rate",
      `Rate has more than ${MAX_RATE_SCALE} decimals: "${text}"`,
    );
  }
  const numerator = BigInt(integer + significant);
  if (numerator === 0n) throw new MoneyError("invalid_rate", "Rate must be greater than zero");
  if (integer.replace(/^0+/, "").length > MAX_RATE_INTEGER_DIGITS) {
    throw new MoneyError("invalid_rate", `Rate is too large: "${text}"`);
  }
  return { numerator, scale: significant.length };
}

/** Converts a JSON number (as returned by rate APIs) to a Rate through its shortest decimal text. */
export function rateFromNumber(value: number): Rate {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MoneyError(
      "invalid_rate",
      `Rate must be a positive finite number, got ${String(value)}`,
    );
  }
  const text = String(value);
  return parseRate(/e/i.test(text) ? value.toFixed(MAX_RATE_SCALE) : text);
}

/** Canonical decimal text with no trailing zeros, e.g. "1.4344". */
export function formatRate(rate: Rate): string {
  const digits = rate.numerator.toString().padStart(rate.scale + 1, "0");
  const integer = digits.slice(0, digits.length - rate.scale);
  const fraction = digits.slice(digits.length - rate.scale).replace(/0+$/, "");
  return fraction === "" ? integer : `${integer}.${fraction}`;
}

export function rateEquals(a: Rate, b: Rate): boolean {
  return formatRate(a) === formatRate(b);
}

/**
 * Converts minor units of `from` into minor units of `to`, rounding half away
 * from zero to the nearest minor unit of `to`. `rate` is `to` per 1 `from`.
 */
export function convertMinor(
  minor: Minor,
  from: CurrencyCode,
  to: CurrencyCode,
  rate: Rate,
): Minor {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`minor must be a safe integer, got ${String(minor)}`);
  }
  const magnitude = BigInt(Math.abs(minor));
  const numerator = magnitude * rate.numerator * 10n ** BigInt(minorUnitExponent(to));
  const denominator = 10n ** BigInt(rate.scale + minorUnitExponent(from));
  const rounded = toSafeNumber(divRoundHalfUp(numerator, denominator), "converted amount");
  return minor < 0 ? -rounded : rounded;
}
