"use server";

import { revalidatePath } from "next/cache";
import { validateBudgetForm, validateTripForm } from "@/lib/dashboard";
import type { FieldErrors } from "@/lib/ledger";
import { LedgerError } from "@/server/ledger";
import { openStore } from "@/server/runtime";

/** What a settings form returns: field messages when it did not save, a short note when it did. */
export interface SettingsState {
  readonly errors: FieldErrors;
  readonly saved?: string;
}

function refresh(): void {
  revalidatePath("/", "layout");
}

async function guarded(work: () => Promise<string>): Promise<SettingsState> {
  try {
    const saved = await work();
    refresh();
    return { errors: {}, saved };
  } catch (error) {
    if (error instanceof LedgerError) return { errors: { form: error.message } };
    throw error;
  }
}

/** The default daily budget, or one day's budget when the form carries a day. */
export async function saveBudgetAction(
  dayRequired: boolean,
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const checked = validateBudgetForm(formData, { dayRequired });
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () => {
    await store.setBudget(checked.value);
    return checked.value.day === null ? "Daily budget saved" : "Budget for that day saved";
  });
}

export async function clearBudgetAction(day: string | null): Promise<void> {
  const store = await openStore();
  await store.clearBudget(day);
  refresh();
}

export async function saveTripAction(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const checked = validateTripForm(formData);
  if (!checked.ok) return { errors: checked.errors };
  const store = await openStore();
  return guarded(async () => {
    await store.updateTrip(checked.value);
    return "Trip saved";
  });
}
