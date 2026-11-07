import type { Metadata } from "next";
import { ExpenseForm } from "@/components/expense-form";
import { PageHeader, SignedOut } from "@/components/ui";
import { blankExpenseForm, todayIn } from "@/lib/ledger";
import { openStore } from "@/server/runtime";

export const metadata: Metadata = { title: "Add expense" };

export default async function NewExpensePage() {
  const store = await openStore();
  if (!store) return <SignedOut />;
  const members = await store.members();
  const today = todayIn(new Date());
  return (
    <>
      <PageHeader title="Add expense" back={{ href: "/expenses", label: "Expenses" }} />
      <ExpenseForm
        members={members}
        initial={blankExpenseForm({ members, payerUserId: store.session.userId, today })}
        expenseId={null}
        version={null}
        serverToday={today}
      />
    </>
  );
}
