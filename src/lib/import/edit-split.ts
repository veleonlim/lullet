import {
  defaultMembers,
  evenPercents,
  resolveSplit,
  type BatchSplit,
  type DraftSplitMode,
  type Percents,
  type RowSplitOverride,
} from "./split";

/**
 * What each tap on the review screen does to the split choices, as plain functions so they can be
 * tested without a browser. A row that ends up exactly like the batch default carries no override
 * at all (null), so it keeps following the batch when the batch changes.
 */

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function inOrder(ids: Iterable<string>, order: readonly string[]): string[] {
  const wanted = new Set(ids);
  return order.filter((id) => wanted.has(id));
}

/** Drops an override that resolves to exactly what the batch already gives the row. */
function tidy(
  override: RowSplitOverride,
  batch: BatchSplit,
  order: readonly string[],
): RowSplitOverride | null {
  const mine = resolveSplit(batch, override, order);
  const theirs = resolveSplit(batch, null, order);
  if (
    mine.ok &&
    theirs.ok &&
    mine.split.mode === theirs.split.mode &&
    sameMembers(mine.split.members, theirs.split.members) &&
    JSON.stringify(mine.split.basisPoints) === JSON.stringify(theirs.split.basisPoints)
  ) {
    return null;
  }
  return override;
}

/** The members a row is shared by right now. */
function currentMembers(
  batch: BatchSplit,
  override: RowSplitOverride | null,
  order: readonly string[],
): string[] {
  const resolved = resolveSplit(batch, override, order);
  if (resolved.ok) return [...resolved.split.members];
  return override?.members
    ? inOrder(override.members, order)
    : defaultMembers(order, batch.payerIds, batch.includePayers);
}

/** One tap on a person's chip on a row: out if they are in, in if they are out. */
export function toggleRowMember(
  batch: BatchSplit,
  override: RowSplitOverride | null,
  userId: string,
  order: readonly string[],
): RowSplitOverride | null {
  const members = currentMembers(batch, override, order);
  const next = inOrder(
    members.includes(userId) ? members.filter((id) => id !== userId) : [...members, userId],
    order,
  );
  const mode = override?.mode ?? batch.mode;
  if (mode === "percent") {
    // Whoever is in shares equally again; the percentages can then be adjusted.
    return { mode: "percent", members: next, percents: next.length > 0 ? evenPercents(next) : {} };
  }
  const base: RowSplitOverride = {
    ...(override?.mode ? { mode: override.mode } : {}),
    members: next,
  };
  return tidy(base, batch, order);
}

/** Switch a row between equal shares and percentages. */
export function setRowMode(
  batch: BatchSplit,
  override: RowSplitOverride | null,
  mode: DraftSplitMode,
  order: readonly string[],
): RowSplitOverride | null {
  const members = currentMembers(batch, override, order);
  if (mode === "percent") {
    const percents =
      override?.percents && sameMembers(inOrder(Object.keys(override.percents), order), members)
        ? override.percents
        : evenPercents(members);
    return { mode: "percent", members, percents };
  }
  const base: RowSplitOverride = { mode: "equal", members };
  return tidy(base, batch, order);
}

/** Type a percentage for one person on a row in percent mode. */
export function setRowPercent(
  batch: BatchSplit,
  override: RowSplitOverride | null,
  userId: string,
  basisPoints: number,
  order: readonly string[],
): RowSplitOverride {
  const members = currentMembers(batch, override, order);
  const resolved = resolveSplit(batch, { ...override, mode: "percent" }, order);
  const known: Percents =
    resolved.ok && resolved.split.basisPoints ? resolved.split.basisPoints : evenPercents(members);
  const percents: Record<string, number> = {};
  for (const id of members) percents[id] = known[id] ?? 0;
  percents[userId] = basisPoints;
  return { mode: "percent", members, percents };
}

/** Add or remove a payer; at least one payer always remains. */
export function toggleBatchPayer(
  batch: BatchSplit,
  userId: string,
  order: readonly string[],
): BatchSplit {
  const has = batch.payerIds.includes(userId);
  if (has && batch.payerIds.length === 1) return batch;
  const payerIds = inOrder(
    has ? batch.payerIds.filter((id) => id !== userId) : [...batch.payerIds, userId],
    order,
  );
  return { ...batch, payerIds };
}

/** The batch's default split: equal, or percentages that start out even. */
export function setBatchMode(
  batch: BatchSplit,
  mode: DraftSplitMode,
  order: readonly string[],
): BatchSplit {
  if (mode === "equal") return { ...batch, mode, percents: null };
  const members = defaultMembers(order, batch.payerIds, batch.includePayers);
  return { ...batch, mode, percents: evenPercents(members) };
}

/** One tap on a person's chip in the batch percent split. */
export function toggleBatchPercentMember(
  batch: BatchSplit,
  userId: string,
  order: readonly string[],
): BatchSplit {
  const current = inOrder(Object.keys(batch.percents ?? {}), order);
  const next = inOrder(
    current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    order,
  );
  return { ...batch, percents: next.length > 0 ? evenPercents(next) : {} };
}

export function setBatchPercent(
  batch: BatchSplit,
  userId: string,
  basisPoints: number,
): BatchSplit {
  return { ...batch, percents: { ...(batch.percents ?? {}), [userId]: basisPoints } };
}
