"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  validateExpenseForm,
  validateSettlementForm,
  type FieldErrors,
  type Validated,
} from "@/lib/ledger";
import { LedgerError, RateUnavailableError } from "@/server/ledger";
import { openStore } from "@/server/runtime";

/** What a form action returns when it did not save: messages by field, plus a form level one. */
export interface FormState {
  readonly errors: FieldErrors;
}

const SIGNED_OUT: FormState = { errors: { form: "You are signed out. Sign in and try again." } };

function readPayload(formData: FormData): unknown {
  const payload = formData.get("payload");
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/** Turns a failure of the data layer into something a person can act on. */
function describeFailure(error: unknown, rateField: string): FormState {
  if (error instanceof RateUnavailableError) {
    return {
      errors: {
        [rateField]: `No ${error.currency} to SGD rate is available for ${error.date} right now. Enter your own rate here, or try again later.`,
      },
    };
  }
  if (error instanceof LedgerError) return { errors: { form: error.message } };
  throw error;
}

function refresh(): void {
  revalidatePath("/", "layout");
}

export async function saveExpenseAction(
  expenseId: string | null,
  version: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const store = await openStore();
  if (!store) return SIGNED_OUT;
  const members = await store.members();
  const checked = validateExpenseForm(
    readPayload(formData),
    members.map((member) => member.userId),
  );
  if (!checked.ok) return { errors: checked.errors };

  let savedId: string;
  try {
    if (expenseId === null) {
      savedId = (await store.createExpense(checked.value)).id;
    } else {
      const expected = new Date(version ?? "");
      if (Number.isNaN(expected.getTime())) {
        return { errors: { form: "Reload the page to edit this expense." } };
      }
      savedId = (await store.updateExpense(expenseId, checked.value, expected)).id;
    }
  } catch (error) {
    return describeFailure(error, "rate.rate");
  }
  refresh();
  redirect(`/expenses/${savedId}`);
}

export async function deleteExpenseAction(expenseId: string): Promise<void> {
  const store = await openStore();
  if (!store) redirect("/expenses");
  await store.deleteExpense(expenseId);
  refresh();
  redirect(`/expenses?removed=${expenseId}`);
}

export async function restoreExpenseAction(expenseId: string): Promise<void> {
  const store = await openStore();
  if (!store) redirect("/expenses");
  await store.restoreExpense(expenseId);
  refresh();
  redirect(`/expenses/${expenseId}`);
}

export async function saveSettlementAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const store = await openStore();
  if (!store) return SIGNED_OUT;
  const members = await store.members();
  const checked: Validated<Parameters<typeof store.createSettlement>[0]> = validateSettlementForm(
    readPayload(formData),
    members.map((member) => member.userId),
  );
  if (!checked.ok) return { errors: checked.errors };
  try {
    await store.createSettlement(checked.value);
  } catch (error) {
    return describeFailure(error, "rate.rate");
  }
  refresh();
  redirect("/balances?settled=1");
}

export async function deleteSettlementAction(settlementId: string): Promise<void> {
  const store = await openStore();
  if (!store) redirect("/balances");
  await store.deleteSettlement(settlementId);
  refresh();
  redirect(`/balances?removedSettlement=${settlementId}`);
}

export async function restoreSettlementAction(settlementId: string): Promise<void> {
  const store = await openStore();
  if (!store) redirect("/balances");
  await store.restoreSettlement(settlementId);
  refresh();
  redirect("/balances");
}
