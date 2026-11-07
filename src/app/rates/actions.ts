"use server";

import { revalidatePath } from "next/cache";
import { validateDayCurrency, validateRateForm } from "@/lib/dashboard";
import { describePricing, formatDay, type FieldErrors } from "@/lib/ledger";
import { LedgerError, RateUnavailableError, type RepriceResult } from "@/server/ledger";
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

/** Sets a day's default rate. Its expenses are re-priced at once and every change is audit-logged. */
async function saveDayRate(_previous: RateState, formData: FormData): Promise<RateState> {
  const checked = validateRateForm(formData);
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () =>
    summarise(
      await store.setDailyRate(checked.value),
      `Rate saved for ${formatDay(checked.value.day)}.`,
    ),
  );
}

async function clearDayRate(_previous: RateState, formData: FormData): Promise<RateState> {
  const checked = validateDayCurrency(formData);
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () =>
    summarise(
      await store.clearDailyRate(checked.value),
      `Rate removed for ${formatDay(checked.value.day)}.`,
    ),
  );
}

/** Re-checks a day: fetches a missing market rate and re-prices through the usual precedence. */
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
