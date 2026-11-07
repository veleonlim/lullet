import type { Metadata } from "next";
import Link from "next/link";
import { ExpenseRow } from "@/components/expense-row";
import { ReceiptIcon } from "@/components/icons";
import { Button, ButtonLink, Card, Notice, PageHeader, SignedOut } from "@/components/ui";
import {
  formatDay,
  formatMoney,
  groupByDay,
  priceExpenses,
  summariseLedger,
  type PricedExpense,
} from "@/lib/ledger";
import { REPORTING_CURRENCY } from "@/lib/money";
import { openStore } from "@/server/runtime";
import { restoreExpenseAction } from "../actions";
import { route } from "@/lib/routes";

export const metadata: Metadata = { title: "Expenses" };

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; removed?: string }>;
}) {
  const store = await openStore();
  if (!store) return <SignedOut />;
  const params = await searchParams;
  const showDeleted = params.view === "deleted";

  const ledger = await store.loadLedger();
  const order = ledger.members.map((member) => member.userId);
  const summary = summariseLedger({
    memberOrder: order,
    expenses: ledger.expenses,
    settlements: ledger.settlements,
    book: ledger.book,
  });
  const deleted = await store.listExpenses({ deleted: true });
  const removed = params.removed ? await store.getExpense(params.removed) : null;

  const shown = showDeleted ? deleted : ledger.expenses;
  const priced = priceExpenses(shown, ledger.book, order);
  const days = groupByDay<PricedExpense>(priced, (item) => item.expense.spentOn);
  const currentYear = new Date().getUTCFullYear();

  const mine = summary.balances.reporting.find((entry) => entry.memberId === store.session.userId);
  const balance = mine?.balanceMinor ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Expenses"
        actions={
          <ButtonLink href="/expenses/new" variant="primary">
            Add expense
          </ButtonLink>
        }
      />

      {removed?.deletedAt ? (
        <Notice
          role="status"
          action={
            <form action={restoreExpenseAction.bind(null, removed.id)}>
              <Button type="submit" variant="ghost" className="min-h-9 px-3">
                Undo
              </Button>
            </form>
          }
        >
          Deleted <strong className="font-semibold">{removed.description}</strong>.
        </Notice>
      ) : null}

      {!showDeleted ? (
        <Link
          href="/balances"
          className="block rounded-2xl border border-border bg-surface p-4 transition-colors hover:bg-surface-muted"
        >
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                Group total
              </p>
              <p className="num mt-1 text-2xl font-semibold" data-testid="group-total">
                {formatMoney(summary.totalSpendMinor, REPORTING_CURRENCY)}
              </p>
              <p className="text-sm text-muted">
                {ledger.expenses.length} {ledger.expenses.length === 1 ? "expense" : "expenses"}
              </p>
            </div>
            <p
              className={`text-right text-sm font-medium ${
                balance > 0 ? "text-positive" : balance < 0 ? "text-negative" : "text-muted"
              }`}
              data-testid="my-balance"
            >
              {balance > 0
                ? `You are owed ${formatMoney(balance, REPORTING_CURRENCY)}`
                : balance < 0
                  ? `You owe ${formatMoney(-balance, REPORTING_CURRENCY)}`
                  : "You are settled up"}
            </p>
          </div>
        </Link>
      ) : null}

      {summary.unpricedExpenseIds.length > 0 && !showDeleted ? (
        <Notice tone="warning">
          {summary.unpricedExpenseIds.length === 1
            ? "One expense has no exchange rate yet, so it is left out of the totals."
            : `${String(summary.unpricedExpenseIds.length)} expenses have no exchange rate yet, so they are left out of the totals.`}{" "}
          Open it and add a rate.
        </Notice>
      ) : null}

      <nav aria-label="Expense filter" className="flex gap-2">
        <FilterLink href="/expenses" active={!showDeleted}>
          Active
        </FilterLink>
        <FilterLink href="/expenses?view=deleted" active={showDeleted}>
          Deleted{deleted.length > 0 ? ` (${String(deleted.length)})` : ""}
        </FilterLink>
      </nav>

      {days.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <ReceiptIcon width={24} height={24} />
          </span>
          <p className="font-medium">{showDeleted ? "Nothing deleted" : "No expenses yet"}</p>
          <p className="max-w-xs text-sm text-muted">
            {showDeleted
              ? "Deleted expenses wait here, and can be restored."
              : "Add the first expense and lullet works out who owes whom."}
          </p>
          {showDeleted ? null : (
            <ButtonLink href="/expenses/new" variant="primary">
              Add an expense
            </ButtonLink>
          )}
        </Card>
      ) : (
        days.map((day) => {
          const total = day.items.reduce((sum, item) => sum + (item.sgd?.totalMinor ?? 0), 0);
          return (
            <section key={day.date} aria-label={formatDay(day.date, currentYear)}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {formatDay(day.date, currentYear)}
                </h2>
                {!showDeleted ? (
                  <span className="num text-xs text-muted">
                    {formatMoney(total, REPORTING_CURRENCY)}
                  </span>
                ) : null}
              </div>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                {day.items.map((item) => (
                  <ExpenseRow
                    key={item.expense.id}
                    priced={item}
                    members={ledger.members}
                    deleted={showDeleted}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={route(href)}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full px-4 text-sm font-medium ${
        active
          ? "bg-foreground text-background"
          : "bg-surface-muted text-muted hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}
