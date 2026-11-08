import { defaultMembers, type BatchSplit, type RowSplitOverride } from "@/lib/import/split";
import type { CaptionPlan } from "./caption";

export interface AppliedCaption {
  readonly batch: BatchSplit;
  /** What every row should share instead of the batch default; null leaves the rows alone. */
  readonly rowSplit: RowSplitOverride | null;
}

function inOrder(ids: Iterable<string>, order: readonly string[]): string[] {
  const wanted = new Set(ids);
  return order.filter((id) => wanted.has(id));
}

/** Turns what a caption asked for into the batch's payers and a per-row member list. */
export function applyCaptionPlan(
  plan: CaptionPlan,
  batch: BatchSplit,
  order: readonly string[],
): AppliedCaption {
  const payerIds = plan.paidBy ? inOrder(plan.paidBy, order) : batch.payerIds;
  const next: BatchSplit = { ...batch, payerIds: payerIds.length > 0 ? payerIds : batch.payerIds };
  const defaults = defaultMembers(order, next.payerIds, next.includePayers);

  let members: string[] | null = null;
  if (plan.splitBetween) members = inOrder(plan.splitBetween, order);
  else if (plan.exclude.length > 0) members = defaults.filter((id) => !plan.exclude.includes(id));
  if (members === null || members.length === 0) return { batch: next, rowSplit: null };
  const same = members.length === defaults.length && members.every((id, i) => id === defaults[i]);
  return { batch: next, rowSplit: same ? null : { members } };
}
