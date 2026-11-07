"use server";

import { revalidatePath } from "next/cache";
import { validateDayCurrency, validateRateForm } from "@/lib/dashboard";
import { describePricing, formatDay, type FieldErrors } from "@/lib/ledger";
import {
  LedgerError,
  RateUnavailableError,
  type RepriceOffer,
  type RepriceResult,
} from "@/server/ledger";
import { openStore } from "@/server/runtime";

export interface RateState {
  readonly errors: FieldErrors;
  /** What happened, in a sentence or two. */
  readonly message?: string;
  /** One line per expense whose SGD figure changed. */
  readonly changes?: readonly string[];
}

function summarise(result: RepriceResult, lead: string): RateState {
  const count = result.changes.length;
  const sentence =
    count === 0
      ? `${lead} No expense needed re-pricing.`
      : `${lead} Re-priced ${String(count)} ${count === 1 ? "expense" : "expenses"}.`;
  return {
    errors: {},
    message: sentence,
    changes: result.changes.map(
      (change) =>
        `${change.description}: ${describePricing(change.before)} to ${describePricing(change.after)}`,
    ),
  };
}

function kept(offer: RepriceOffer, lead: string): RateState {
  const count = (n: number) => `${String(n)} ${n === 1 ? "expense" : "expenses"}`;
  const outlook =
    offer.eligible === 0
      ? ""
      : offer.wouldChange === 0
        ? ` Re-pricing the ${count(offer.eligible)} on this day would not change a figure.`
        : ` Re-pricing would change ${String(offer.wouldChange)} of the ${count(offer.eligible)} on this day.`;
  return { errors: {}, message: `${lead} Existing expenses keep their figures.${outlook}` };
}

async function guarded(work: () => Promise<RateState>): Promise<RateState> {
  try {
    const state = await work();
    revalidatePath("/", "layout");
    return state;
  } catch (error) {
    if (error instanceof RateUnavailableError) {
      return {
        errors: {
          form: `No ${error.currency} to SGD market rate is available for ${error.date} right now, so this was not changed. Try again later.`,
        },
      };
    }
    if (error instanceof LedgerError) return { errors: { form: error.message } };
    throw error;
  }
}

/** Sets a day's default rate. No expense moves until the day is re-priced. */
async function saveDayRate(_previous: RateState, formData: FormData): Promise<RateState> {
  const checked = validateRateForm(formData);
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () => kept(await store.setDailyRate(checked.value), "Rate saved."));
}

async function clearDayRate(_previous: RateState, formData: FormData): Promise<RateState> {
  const checked = validateDayCurrency(formData);
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () => kept(await store.clearDailyRate(checked.value), "Rate removed."));
}

/** Moves the day's eligible expenses to the day's current rate, fetching a missing market rate first. */
async function repriceDay(_previous: RateState, formData: FormData): Promise<RateState> {
  const checked = validateDayCurrency(formData);
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () => {
    const result = await store.repriceDay(checked.value);
    const checkedCount = `Checked ${String(result.affected)} ${result.affected === 1 ? "expense" : "expenses"} on ${formatDay(checked.value.day)}.`;
    return summarise(result, checkedCount);
  });
}

/**
 * One form per day drives all three actions, told apart by the button pressed (`intent`), so the
 * form always shows what the most recent press did.
 */
export async function dayRateAction(previous: RateState, formData: FormData): Promise<RateState> {
  const intent = formData.get("intent");
  if (intent === "clear") return clearDayRate(previous, formData);
  if (intent === "reprice") return repriceDay(previous, formData);
  return saveDayRate(previous, formData);
}
