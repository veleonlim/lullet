import { MoneyError } from "./errors";
import {
  assertNonNegativeMinor,
  assertSafeInteger,
  sum,
  toSafeNumber,
  type Minor,
} from "./integer";

/**
 * Splitting an amount between people without losing or inventing a single
 * minor unit.
 *
 * Every split uses the largest-remainder (Hamilton) method: each person gets
 * the floor of their exact proportional share, then the units left over are
 * handed out one each to the largest fractional remainders. Ties go to the
 * earlier person, so the result only depends on the order of the input. Callers
 * pass the group's fixed member order (or `memberOrder`) to make that order
 * stable across edits. For example 14849 over three people is [4950, 4950, 4949].
 */

export type MemberId = string;

export interface Allocation {
  readonly memberId: MemberId;
  readonly minor: Minor;
}

/** 100.00 percent expressed in basis points. */
export const FULL_BASIS_POINTS = 10_000;

export type SplitSpec =
  | { readonly kind: "equal"; readonly members: readonly MemberId[] }
  | { readonly kind: "exact"; readonly entries: readonly { memberId: MemberId; minor: Minor }[] }
  | {
      readonly kind: "percent";
      readonly entries: readonly { memberId: MemberId; basisPoints: number }[];
    }
  | {
      readonly kind: "shares";
      readonly entries: readonly { memberId: MemberId; shares: number }[];
    };

/**
 * Core largest-remainder allocation of `total` across non-negative integer
 * `weights`. The result has the same length and order as `weights`, sums to
 * `total` exactly, and gives zero to zero weights.
 */
export function allocateProportional(total: Minor, weights: readonly number[]): Minor[] {
  assertNonNegativeMinor(total, "total");
  for (const weight of weights) assertNonNegativeMinor(weight, "weight");
  if (weights.length === 0) {
    throw new MoneyError("empty_split", "Cannot allocate between zero people");
  }
  if (total === 0) return weights.map(() => 0);

  const weightSum = weights.reduce((acc, weight) => acc + BigInt(weight), 0n);
  if (weightSum === 0n) {
    throw new MoneyError("invalid_weight", "At least one weight must be positive");
  }

  const bigTotal = BigInt(total);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  for (const weight of weights) {
    const product = bigTotal * BigInt(weight);
    floors.push(product / weightSum);
    remainders.push(product % weightSum);
  }

  const assigned = floors.reduce((acc, floor) => acc + floor, 0n);
  const leftover = Number(bigTotal - assigned);

  const byRemainderThenPosition = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );

  const result = floors.map((floor) => toSafeNumber(floor, "share"));
  for (let i = 0; i < leftover; i += 1) {
    const winner = byRemainderThenPosition[i];
    if (winner) result[winner.index] = (result[winner.index] ?? 0) + 1;
  }
  return result;
}

function normalizeMembers<T extends { memberId: MemberId }>(
  entries: readonly T[],
  memberOrder: readonly MemberId[] | undefined,
): T[] {
  if (entries.length === 0) {
    throw new MoneyError("empty_split", "A split needs at least one person");
  }
  const seen = new Set<MemberId>();
  for (const entry of entries) {
    if (seen.has(entry.memberId)) {
      throw new MoneyError("duplicate_member", `Member listed twice: ${entry.memberId}`);
    }
    seen.add(entry.memberId);
  }
  if (!memberOrder) return [...entries];

  const position = new Map(memberOrder.map((id, index) => [id, index] as const));
  for (const entry of entries) {
    if (!position.has(entry.memberId)) {
      throw new MoneyError("unknown_member", `Member not in the fixed order: ${entry.memberId}`);
    }
  }
  return [...entries].sort(
    (a, b) => (position.get(a.memberId) ?? 0) - (position.get(b.memberId) ?? 0),
  );
}

/**
 * Splits `total` according to `spec`. The result lists exactly the members of
 * the spec, in tie order (the `memberOrder` if given, else the spec order),
 * and always sums to `total`.
 */
export function allocateSplit(
  total: Minor,
  spec: SplitSpec,
  memberOrder?: readonly MemberId[],
): Allocation[] {
  assertNonNegativeMinor(total, "total");

  switch (spec.kind) {
    case "equal": {
      const members = normalizeMembers(
        spec.members.map((memberId) => ({ memberId })),
        memberOrder,
      );
      const minors = allocateProportional(
        total,
        members.map(() => 1),
      );
      return members.map((member, i) => ({ memberId: member.memberId, minor: minors[i] ?? 0 }));
    }
    case "exact": {
      const entries = normalizeMembers(spec.entries, memberOrder);
      for (const entry of entries) assertNonNegativeMinor(entry.minor, "exact amount");
      const entered = sum(entries.map((entry) => entry.minor));
      if (entered !== total) {
        throw new MoneyError(
          "split_total_mismatch",
          `Exact amounts total ${entered} but the expense is ${total}`,
        );
      }
      return entries.map((entry) => ({ memberId: entry.memberId, minor: entry.minor }));
    }
    case "percent": {
      const entries = normalizeMembers(spec.entries, memberOrder);
      for (const entry of entries) assertNonNegativeMinor(entry.basisPoints, "basis points");
      const entered = sum(entries.map((entry) => entry.basisPoints));
      if (entered !== FULL_BASIS_POINTS) {
        throw new MoneyError(
          "percent_total_mismatch",
          `Percentages total ${entered} basis points, expected ${FULL_BASIS_POINTS}`,
        );
      }
      const minors = allocateProportional(
        total,
        entries.map((entry) => entry.basisPoints),
      );
      return entries.map((entry, i) => ({ memberId: entry.memberId, minor: minors[i] ?? 0 }));
    }
    case "shares": {
      const entries = normalizeMembers(spec.entries, memberOrder);
      for (const entry of entries) assertSafeInteger(entry.shares, "shares");
      const minors = allocateProportional(
        total,
        entries.map((entry) => entry.shares),
      );
      return entries.map((entry, i) => ({ memberId: entry.memberId, minor: minors[i] ?? 0 }));
    }
  }
}

/**
 * Convenience for the default case in the agreed flow: the payer paid it all
 * and the listed members split it equally.
 */
export function equalSplit(
  total: Minor,
  members: readonly MemberId[],
  memberOrder?: readonly MemberId[],
): Allocation[] {
  return allocateSplit(total, { kind: "equal", members }, memberOrder);
}
