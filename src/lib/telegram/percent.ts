import { resolveSplit, type BatchSplit, type RowSplitOverride } from "@/lib/import/split";
import { FULL_BASIS_POINTS } from "@/lib/money";
import { setRowMode } from "@/lib/import/edit-split";

/** One tap on a "+5%" or "-5%" button moves this many basis points. */
export const NUDGE_STEP = 500;

/**
 * Nudges one person's percentage on a row. Whoever is last on the row takes the other side of the
 * change (and the first person does when the last one is nudged), so the row keeps adding up to
 * 100% and a tap never leaves a half-finished split behind.
 */
export function nudgeRowPercent(
  batch: BatchSplit,
  override: RowSplitOverride | null,
  memberId: string,
  direction: 1 | -1,
  order: readonly string[],
): RowSplitOverride | null {
  const percentOverride = setRowMode(batch, override, "percent", order);
  const resolved = resolveSplit(batch, percentOverride, order);
  if (!resolved.ok || resolved.split.basisPoints === null) return percentOverride;
  const { members, basisPoints } = resolved.split;
  if (!members.includes(memberId) || members.length < 2) return percentOverride;

  const partner =
    members[members.length - 1] === memberId ? members[0] : members[members.length - 1];
  if (partner === undefined) return percentOverride;
  const mine = basisPoints[memberId] ?? 0;
  const theirs = basisPoints[partner] ?? 0;
  // Both people stay between 0% and 100%.
  const wanted = direction * NUDGE_STEP;
  const applied = Math.min(
    Math.max(wanted, -mine, theirs - FULL_BASIS_POINTS),
    FULL_BASIS_POINTS - mine,
    theirs,
  );
  if (applied === 0) return percentOverride;

  return {
    mode: "percent",
    members: [...members],
    percents: { ...basisPoints, [memberId]: mine + applied, [partner]: theirs - applied },
  };
}

export type TypedPercents =
  | { readonly ok: true; readonly percents: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly message: string };

/**
 * Reads typed percentages such as "60 40", "60,40" or "60/40" for the people on a row in order.
 * Spaces, commas and slashes separate values; only a dot is a decimal point. Leaving the last one
 * out gives them the remainder. Two decimals are allowed ("33.33 33.33 33.34").
 */
export function parseTypedPercents(text: string, members: readonly string[]): TypedPercents {
  const numbers = [...text.matchAll(/(\d+(?:\.\d{1,2})?)\s*%?/g)].map((match) => {
    const [whole = "0", fraction = ""] = (match[1] ?? "0").split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  });
  if (numbers.length === 0 || members.length === 0) {
    return { ok: false, message: "Reply with percentages, like 60 40." };
  }
  if (numbers.length !== members.length && numbers.length !== members.length - 1) {
    return {
      ok: false,
      message: `Send ${String(members.length)} percentages, one per person in the order shown.`,
    };
  }
  const given = numbers.reduce((total, value) => total + value, 0);
  const all = numbers.length === members.length ? numbers : [...numbers, FULL_BASIS_POINTS - given];
  const total = all.reduce((sum, value) => sum + value, 0);
  if (all.some((value) => value < 0 || value > FULL_BASIS_POINTS) || total !== FULL_BASIS_POINTS) {
    return { ok: false, message: "The percentages must add up to 100." };
  }
  return { ok: true, percents: Object.fromEntries(members.map((id, i) => [id, all[i] ?? 0])) };
}
