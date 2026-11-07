import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { CategoryIcon, ClockIcon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { Button, ButtonLink, Card, Notice, PageHeader, Pill, SectionTitle } from "@/components/ui";
import {
  categoryLabel,
  describeConversion,
  formatBasisPoints,
  formatDate,
  formatMoney,
  priceExpenses,
  type Member,
  type StoredExpense,
} from "@/lib/ledger";
import { assertCurrencyCode, REPORTING_CURRENCY, type Allocation } from "@/lib/money";
import { openStore } from "@/server/runtime";
import { deleteExpenseAction, restoreExpenseAction } from "../../actions";
import { route } from "@/lib/routes";

export const metadata: Metadata = { title: "Expense" };

export default async function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const store = await openStore();
  const { id } = await params;
  const expense = await store.getExpense(id);
  if (!expense) notFound();

  const members = await store.members();
  const book = await store.rateBookFor([expense]);
  const order = members.map((member) => member.userId);
  const [priced] = priceExpenses([expense], book, order);
  const sgd = priced?.sgd;
  const nameOf = (userId: string) =>
    members.find((member) => member.userId === userId)?.displayName ?? "Someone";
  const currency = assertCurrencyCode(expense.currency);
  const conversion = sgd ? describeConversion(expense, sgd) : null;
  const deleted = expense.deletedAt !== null;

  return (
    <div className="space-y-5">
      <PageHeader title={expense.description} back={{ href: "/expenses", label: "Expenses" }} />

      {deleted ? (
        <Notice
          tone="warning"
          action={
            <form action={restoreExpenseAction.bind(null, expense.id)}>
              <Button type="submit" variant="secondary" className="min-h-9 px-3">
                Restore
              </Button>
            </form>
          }
        >
          Deleted by {expense.deletedBy ? nameOf(expense.deletedBy) : "someone"}. It does not count
          towards balances.
        </Notice>
      ) : null}

      <Card className="p-5">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <CategoryIcon category={expense.category} width={24} height={24} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="num text-3xl font-semibold tracking-tight" data-testid="native-amount">
              {formatMoney(expense.amountMinor, currency)}
            </p>
            {sgd && currency !== REPORTING_CURRENCY ? (
              <p className="num mt-0.5 text-lg text-muted" data-testid="sgd-amount">
                {formatMoney(sgd.totalMinor, REPORTING_CURRENCY)}
              </p>
            ) : null}
            {!sgd ? (
              <p className="mt-1 text-sm text-warning">
                No exchange rate yet, so this is not counted in SGD.
              </p>
            ) : null}
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span>{formatDate(expense.spentOn)}</span>
              <span aria-hidden="true">·</span>
              <Pill>{categoryLabel(expense.category)}</Pill>
              {deleted ? <Pill tone="warning">Deleted</Pill> : null}
            </p>
          </div>
        </div>

        {conversion?.headline || expense.billedAmountMinor !== null ? (
          <dl className="mt-4 space-y-1 border-t border-border pt-4 text-sm">
            {expense.billedAmountMinor !== null && expense.billedCurrency !== null ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Billed by your bank</dt>
                <dd className="num font-medium" data-testid="billed-amount">
                  {formatMoney(
                    expense.billedAmountMinor,
                    assertCurrencyCode(expense.billedCurrency),
                  )}
                </dd>
              </div>
            ) : null}
            {conversion?.headline ? (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">In SGD</dt>
                <dd className="num text-right font-medium" data-testid="conversion">
                  {conversion.headline}
                </dd>
              </div>
            ) : null}
            {conversion?.detail ? <p className="pt-1 text-muted">{conversion.detail}</p> : null}
          </dl>
        ) : null}
      </Card>

      <section aria-labelledby="paid-by">
        <SectionTitle id="paid-by">Paid by</SectionTitle>
        <PeopleList
          rows={expense.payers.map((payer) => ({
            userId: payer.userId,
            amountMinor: payer.amountMinor,
          }))}
          members={members}
          currency={currency}
          sgd={sgd?.payers}
        />
      </section>

      <section aria-labelledby="split-between">
        <SectionTitle id="split-between">Shared between · {splitLabel(expense)}</SectionTitle>
        <PeopleList
          rows={expense.shares.map((share) => ({
            userId: share.userId,
            amountMinor: share.amountMinor,
            note: shareNote(expense, share.weight),
          }))}
          members={members}
          currency={currency}
          sgd={sgd?.shares}
        />
      </section>

      <Card className="divide-y divide-border text-sm">
        <p className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-muted">Added by</span>
          <span className="text-right">
            <strong className="font-medium">{nameOf(expense.createdBy)}</strong>{" "}
            <LocalTime iso={expense.createdAt.toISOString()} className="text-muted" />
          </span>
        </p>
        {expense.importId ? (
          <Link
            href={route(`/imports/${expense.importId}`)}
            data-testid="from-import"
            className="flex min-h-12 items-center justify-between gap-4 px-4 py-3 font-medium text-accent hover:bg-surface-muted"
          >
            <span>From a screenshot import</span>
            <span className="text-muted">View the original</span>
          </Link>
        ) : null}
        {expense.updatedAt.getTime() !== expense.createdAt.getTime() ? (
          <p className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-muted">Last changed</span>
            <LocalTime iso={expense.updatedAt.toISOString()} className="text-muted" />
          </p>
        ) : null}
        <Link
          href={route(`/expenses/${expense.id}/history`)}
          className="flex min-h-12 items-center justify-between gap-4 px-4 py-3 font-medium text-accent hover:bg-surface-muted"
        >
          <span className="flex items-center gap-2">
            <ClockIcon width={18} height={18} />
            History
          </span>
          <span className="text-muted">Who changed what</span>
        </Link>
      </Card>

      {!deleted ? (
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <form action={deleteExpenseAction.bind(null, expense.id)}>
            <Button type="submit" variant="danger" className="w-full sm:w-auto">
              Delete
            </Button>
          </form>
          <ButtonLink href={`/expenses/${expense.id}/edit`} variant="primary">
            Edit expense
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}

function splitLabel(expense: StoredExpense): string {
  switch (expense.splitMethod) {
    case "equal":
      return "equally";
    case "exact":
      return "exact amounts";
    case "percent":
      return "by percentage";
    case "shares":
      return "by shares";
  }
}

function shareNote(expense: StoredExpense, weight: number | null): string | undefined {
  if (weight === null) return undefined;
  if (expense.splitMethod === "percent") return `${formatBasisPoints(weight)}%`;
  if (expense.splitMethod === "shares")
    return weight === 1 ? "1 share" : `${String(weight)} shares`;
  return undefined;
}

function PeopleList({
  rows,
  members,
  currency,
  sgd,
}: {
  rows: readonly { userId: string; amountMinor: number; note?: string | undefined }[];
  members: readonly Member[];
  currency: ReturnType<typeof assertCurrencyCode>;
  sgd: readonly Allocation[] | undefined;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
      {rows.map((row) => {
        const member = members.find((entry) => entry.userId === row.userId);
        const inSgd = sgd?.find((entry) => entry.memberId === row.userId);
        return (
          <li key={row.userId} className="flex min-h-14 items-center gap-3 px-4 py-2">
            <Avatar name={member?.displayName ?? "?"} position={member?.position ?? 0} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{member?.displayName ?? "Someone"}</span>
              {row.note ? <span className="block text-sm text-muted">{row.note}</span> : null}
            </span>
            <span className="num shrink-0 text-right">
              <span className="block font-medium">{formatMoney(row.amountMinor, currency)}</span>
              {inSgd && currency !== REPORTING_CURRENCY ? (
                <span className="block text-sm text-muted">
                  {formatMoney(inSgd.minor, REPORTING_CURRENCY)}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
