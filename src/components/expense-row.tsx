import Link from "next/link";
import { CategoryIcon } from "./icons";
import { Pill } from "./ui";
import { formatMoney, type Member, type PricedExpense } from "@/lib/ledger";
import { assertCurrencyCode, REPORTING_CURRENCY } from "@/lib/money";
import { route } from "@/lib/routes";

/** "Alex paid", "Alex and Mum paid", "3 people paid". */
export function payerSummary(
  payers: readonly { userId: string }[],
  nameOf: (userId: string) => string,
): string {
  const [first, second] = payers;
  if (!first) return "Nobody paid";
  if (!second) return `${nameOf(first.userId)} paid`;
  if (payers.length === 2) return `${nameOf(first.userId)} and ${nameOf(second.userId)} paid`;
  return `${String(payers.length)} people paid`;
}

export function splitSummary(shareCount: number, memberCount: number): string {
  if (shareCount === memberCount) return `split ${String(memberCount)} ways`;
  return `${String(shareCount)} of ${String(memberCount)} share it`;
}

/** One expense in the list: category icon, what and who, native amount over the SGD figure. */
export function ExpenseRow({
  priced,
  members,
  deleted = false,
}: {
  priced: PricedExpense;
  members: readonly Member[];
  deleted?: boolean;
}) {
  const { expense, sgd } = priced;
  const nameOf = (userId: string) =>
    members.find((member) => member.userId === userId)?.displayName ?? "Someone";
  const currency = assertCurrencyCode(expense.currency);
  const showSgd = currency !== REPORTING_CURRENCY;

  return (
    <li>
      <Link
        href={route(`/expenses/${expense.id}`)}
        className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-muted active:bg-surface-muted"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <CategoryIcon category={expense.category} width={20} height={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate font-medium ${deleted ? "text-muted line-through" : ""}`}
          >
            {expense.description}
          </span>
          <span className="block truncate text-sm text-muted">
            {payerSummary(expense.payers, nameOf)} ·{" "}
            {splitSummary(expense.shares.length, members.length)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={`num block font-semibold ${deleted ? "text-muted line-through" : ""}`}>
            {formatMoney(expense.amountMinor, currency)}
          </span>
          {sgd ? (
            showSgd ? (
              <span className="num block text-sm text-muted">
                {formatMoney(sgd.totalMinor, REPORTING_CURRENCY)}
              </span>
            ) : null
          ) : deleted ? null : (
            <Pill tone="warning">No rate</Pill>
          )}
        </span>
      </Link>
    </li>
  );
}
