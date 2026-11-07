/**
 * Integer guards and bigint helpers shared by the money modules. Amounts cross
 * module boundaries as safe-integer numbers; multiplication-heavy maths runs in
 * bigint so intermediate products can never lose precision.
 */

/** A count of minor units (cents). Always a safe integer; never a float. */
export type Minor = number;

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer, got ${String(value)}`);
  }
}

export function assertNonNegativeMinor(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, got ${String(value)}`);
  }
}

export function assertPositiveMinor(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be positive, got ${String(value)}`);
  }
}

/** Converts a bigint back to a safe-integer number or throws. */
export function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return Number(value);
}

/** Integer division of non-negative bigints rounding half up. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  if (numerator < 0n) throw new RangeError("numerator must not be negative");
  return (2n * numerator + denominator) / (2n * denominator);
}

export function sum(values: readonly number[]): number {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return toSafeNumber(total, "sum");
}
