import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExpenseForm } from "@/components/expense-form";
import { Button, ButtonLink, Notice, PageHeader } from "@/components/ui";
import { expenseToFormValues, todayIn } from "@/lib/ledger";
import { openStore } from "@/server/runtime";
import { restoreExpenseAction } from "../../../actions";

export const metadata: Metadata = { title: "Edit expense" };

export default async function EditExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const store = await openStore();
  const { id } = await params;
  const expense = await store.getExpense(id);
  if (!expense) notFound();
  const members = await store.members();

  return (
    <>
      <PageHeader
        title="Edit expense"
        back={{ href: `/expenses/${id}`, label: expense.description }}
      />
      {expense.deletedAt ? (
        <Notice
          tone="warning"
          action={
            <form action={restoreExpenseAction.bind(null, id)}>
              <Button type="submit" variant="secondary" className="min-h-9 px-3">
                Restore
              </Button>
            </form>
          }
        >
          This expense is deleted. Restore it to edit it.
          <span className="mt-3 block">
            <ButtonLink href={`/expenses/${id}`} variant="ghost" className="-ml-4">
              Back to the expense
            </ButtonLink>
          </span>
        </Notice>
      ) : (
        <ExpenseForm
          members={members}
          initial={expenseToFormValues(expense, members)}
          expenseId={expense.id}
          version={expense.updatedAt.toISOString()}
          serverToday={todayIn(new Date())}
        />
      )}
    </>
  );
}
