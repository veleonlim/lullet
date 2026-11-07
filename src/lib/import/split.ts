import { z } from "zod";
import { evenBasisPoints } from "@/lib/ledger/expense-form";
import { allocateSplit, FULL_BASIS_POINTS, MoneyError, sum } from "@/lib/money";

/**
 * Who paid and who shares a draft row, in the agreed shape: the payer is the uploader unless
 * changed (several payers split each row equally), and the remaining members share the row
 * equally. The payer's own share is a one-tap toggle (off by default), a row can drop or add
 * members, and a row (or the whole batch) can switch to percentages.
 *
 * All of it is plain data so the browser can show live totals and the server can repeat the
 * same maths when it saves and confirms.
 */

export const DRAFT_SPLIT_MODES = ["equal", "percent"] as const;
export type DraftSplitMode = (typeof DRAFT_SPLIT_MODES)[number];

/** Basis points by member id. */
export type Percents = Record<string, number>;

export const percentsSchema = z.record(z.string(), z.number().int().min(0).max(FULL_BASIS_POINTS));

export const rowSplitOverrideSchema = z.object({
  members: z.array(z.string().max(64)).max(20).optional(),
  mode: z.enum(DRAFT_SPLIT_MODES).optional(),
  percents: percentsSchema.optional(),
});

/** What one row changes from the batch. Absent fields follow the batch. */
export type RowSplitOverride = z.infer<typeof rowSplitOverrideSchema>;

/**
 * The batch-wide choices: who paid, whether the payers also take a share (the one-tap toggle, off
 * by default), equal or percent, and for percent mode the percentages rows follow by default.
 */
export const batchSplitSchema = z.object({
  payerIds: z.array(z.string().max(64)).max(20),
  includePayers: z.boolean(),
  mode: z.enum(DRAFT_SPLIT_MODES),
  percents: percentsSchema.nullable(),
});
export type BatchSplit = z.infer<typeof batchSplitSchema>;

export interface ResolvedSplit {
  readonly mode: DraftSplitMode;
  /** In the group's member order. */
  readonly members: readonly string[];
  /** Percent mode only: basis points for each member, adding up to 10000. */
  readonly basisPoints: Percents | null;
}

export type SplitResult =
  | { readonly ok: true; readonly split: ResolvedSplit }
  | { readonly ok: false; readonly message: string };

function inOrder(ids: Iterable<string>, order: readonly string[]): string[] {
  const wanted = new Set(ids);
  return order.filter((id) => wanted.has(id));
}

/** Everyone but the payers, or everyone when the payers take a share too. */
export function defaultMembers(
  order: readonly string[],
  payerIds: readonly string[],
  includePayers: boolean,
): string[] {
  const rest = order.filter((id) => !payerIds.includes(id));
  // A payer who is also the only member left (or the whole group paid) still shares with themselves.
  return includePayers || rest.length === 0 ? [...order] : rest;
}

/** Equal percentages over the members; the first ones take the spare basis points (3334, 3333, 3333). */
export function evenPercents(members: readonly string[]): Percents {
  const points = evenBasisPoints(members.length);
  return Object.fromEntries(members.map((id, index) => [id, points[index] ?? 0]));
}

function percentTotalMessage(total: number): string {
  const whole = Math.trunc(total / 100);
  const fraction = String(total % 100).padStart(2, "0");
  return `Percentages add up to ${String(whole)}.${fraction}%, not 100%`;
}

/** The members and percentages one row will use, or why it cannot be split yet. */
export function resolveSplit(
  batch: BatchSplit,
  override: RowSplitOverride | null,
  order: readonly string[],
): SplitResult {
  const mode = override?.mode ?? batch.mode;
  const fallbackMembers = defaultMembers(order, batch.payerIds, batch.includePayers);

  const candidatePercents =
    override?.percents ??
    (override?.members === undefined && batch.mode === "percent" ? batch.percents : null);

  let members: string[];
  if (override?.members !== undefined) members = inOrder(override.members, order);
  else if (mode === "percent" && candidatePercents)
    members = inOrder(Object.keys(candidatePercents), order);
  else members = fallbackMembers;

  if (members.length === 0)
    return { ok: false, message: "Pick at least one person to share this with" };

  if (mode === "equal") return { ok: true, split: { mode, members, basisPoints: null } };

  const percents =
    candidatePercents && inOrder(Object.keys(candidatePercents), order).join() === members.join()
      ? candidatePercents
      : evenPercents(members);
  const total = sum(members.map((id) => percents[id] ?? 0));
  if (total !== FULL_BASIS_POINTS) return { ok: false, message: percentTotalMessage(total) };
  return { ok: true, split: { mode, members, basisPoints: percents } };
}

export interface RowAllocation {
  readonly splitMethod: DraftSplitMode;
  readonly payers: readonly { userId: string; amountMinor: number }[];
  readonly shares: readonly { userId: string; amountMinor: number; weight: number | null }[];
}

/** Payers and shares of one row in minor units; both add up to the amount exactly. */
export function allocateRow(
  amountMinor: number,
  split: ResolvedSplit,
  payerIds: readonly string[],
  order: readonly string[],
): RowAllocation {
  const payers = inOrder(payerIds, order);
  if (payers.length === 0) throw new MoneyError("empty_split", "Pick who paid");
  const paid = allocateSplit(amountMinor, { kind: "equal", members: payers }, order)
    .filter((entry) => entry.minor > 0)
    .map((entry) => ({ userId: entry.memberId, amountMinor: entry.minor }));

  if (split.mode === "equal") {
    const shares = allocateSplit(amountMinor, { kind: "equal", members: split.members }, order).map(
      (entry) => ({ userId: entry.memberId, amountMinor: entry.minor, weight: null }),
    );
    return { splitMethod: "equal", payers: paid, shares };
  }
  const points = split.basisPoints ?? {};
  const shares = allocateSplit(
    amountMinor,
    {
      kind: "percent",
      entries: split.members.map((memberId) => ({ memberId, basisPoints: points[memberId] ?? 0 })),
    },
    order,
  ).map((entry) => ({
    userId: entry.memberId,
    amountMinor: entry.minor,
    weight: points[entry.memberId] ?? 0,
  }));
  return { splitMethod: "percent", payers: paid, shares };
}

export interface TotalsRow {
  readonly amountMinor: number;
  readonly currency: string;
  readonly split: ResolvedSplit;
}

export interface PersonTotals {
  readonly userId: string;
  /** Per currency: what they paid and what they share, over the rows given. */
  readonly byCurrency: Readonly<Record<string, { paidMinor: number; owesMinor: number }>>;
}

/** Live per-person totals over the rows that will be added, one figure per currency. */
export function computeTotals(
  rows: readonly TotalsRow[],
  payerIds: readonly string[],
  order: readonly string[],
): PersonTotals[] {
  const totals = new Map<string, Record<string, { paidMinor: number; owesMinor: number }>>(
    order.map((id) => [id, {}]),
  );
  const bump = (userId: string, currency: string, field: "paidMinor" | "owesMinor", by: number) => {
    const person = totals.get(userId);
    if (!person) return;
    const entry = (person[currency] ??= { paidMinor: 0, owesMinor: 0 });
    entry[field] += by;
  };
  for (const row of rows) {
    const allocation = allocateRow(row.amountMinor, row.split, payerIds, order);
    for (const payer of allocation.payers)
      bump(payer.userId, row.currency, "paidMinor", payer.amountMinor);
    for (const share of allocation.shares)
      bump(share.userId, row.currency, "owesMinor", share.amountMinor);
  }
  return order.map((userId) => ({ userId, byCurrency: totals.get(userId) ?? {} }));
}

/** What the rows add up to, per currency. */
export function sumByCurrency(
  rows: readonly { amountMinor: number; currency: string }[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) result[row.currency] = (result[row.currency] ?? 0) + row.amountMinor;
  return result;
}
