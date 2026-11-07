import type { Metadata } from "next";
import { Avatar } from "@/components/avatar";
import { ArrowRightIcon, CheckIcon } from "@/components/icons";
import {
  Button,
  ButtonLink,
  Card,
  Notice,
  PageHeader,
  Pill,
  SectionTitle,
  SignedOut,
} from "@/components/ui";
import { assertCurrencyCode, REPORTING_CURRENCY, type MemberBalance } from "@/lib/money";
import {
  formatDate,
  formatMoney,
  formatPlainAmount,
  priceSettlement,
  summariseLedger,
  type Member,
  type StoredSettlement,
} from "@/lib/ledger";
import { openStore } from "@/server/runtime";
import { deleteSettlementAction, restoreSettlementAction } from "../actions";

export const metadata: Metadata = { title: "Balances" };

export default async function BalancesPage({
  searchParams,
}: {
  searchParams: Promise<{ settled?: string; removedSettlement?: string }>;
}) {
  const store = await openStore();
  if (!store) return <SignedOut />;
  const params = await searchParams;

  const ledger = await store.loadLedger();
  const order = ledger.members.map((member) => member.userId);
  const summary = summariseLedger({
    memberOrder: order,
    expenses: ledger.expenses,
    settlements: ledger.settlements,
    book: ledger.book,
  });
  const deletedSettlements = await store.listSettlements({ deleted: true });
  const justRemoved = params.removedSettlement
    ? deletedSettlements.find((settlement) => settlement.id === params.removedSettlement)
    : undefined;
  const me = store.session.userId;

  const nameOf = (userId: string) =>
    ledger.members.find((member) => member.userId === userId)?.displayName ?? "Someone";
  const widest = Math.max(
    1,
    ...summary.balances.reporting.map((entry) => Math.abs(entry.balanceMinor)),
  );
  const settledUp = summary.transfers.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Balances"
        subtitle="Everything is counted in Singapore dollars (SGD)."
        actions={
          <ButtonLink href="/settlements/new" variant="primary">
            Record settlement
          </ButtonLink>
        }
      />

      {params.settled ? (
        <Notice tone="success" role="status">
          Settlement recorded.
        </Notice>
      ) : null}
      {justRemoved ? (
        <Notice
          role="status"
          action={
            <form action={restoreSettlementAction.bind(null, justRemoved.id)}>
              <Button type="submit" variant="ghost" className="min-h-9 px-3">
                Undo
              </Button>
            </form>
          }
        >
          Deleted the settlement from {nameOf(justRemoved.fromUserId)} to{" "}
          {nameOf(justRemoved.toUserId)}.
        </Notice>
      ) : null}
      {summary.unpricedExpenseIds.length + summary.unpricedSettlementIds.length > 0 ? (
        <Notice tone="warning">
          Some records have no exchange rate yet and are left out of these balances. Open them from
          the expense list and add a rate.
        </Notice>
      ) : null}

      <section aria-labelledby="net-balances">
        <SectionTitle id="net-balances">Who is owed what</SectionTitle>
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
          {summary.balances.reporting.map((entry) => (
            <BalanceRow
              key={entry.memberId}
              entry={entry}
              member={ledger.members.find((member) => member.userId === entry.memberId)}
              isMe={entry.memberId === me}
              widest={widest}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="settle-up">
        <SectionTitle id="settle-up">Settle up</SectionTitle>
        {settledUp ? (
          <Card className="flex items-center gap-3 p-4">
            <span className="flex size-10 items-center justify-center rounded-full bg-positive-soft text-positive">
              <CheckIcon width={20} height={20} />
            </span>
            <div>
              <p className="font-medium">Everyone is settled up</p>
              <p className="text-sm text-muted">Nobody owes anyone anything right now.</p>
            </div>
          </Card>
        ) : (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
              {summary.transfers.map((transfer) => {
                const from = ledger.members.find(
                  (member) => member.userId === transfer.fromMemberId,
                );
                const to = ledger.members.find((member) => member.userId === transfer.toMemberId);
                const query = new URLSearchParams({
                  from: transfer.fromMemberId,
                  to: transfer.toMemberId,
                  amount: formatPlainAmount(transfer.minor, REPORTING_CURRENCY),
                });
                return (
                  <li
                    key={`${transfer.fromMemberId}-${transfer.toMemberId}`}
                    className="space-y-2 px-4 py-3"
                    data-testid="transfer"
                  >
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      <Avatar
                        name={from?.displayName ?? "?"}
                        position={from?.position ?? 0}
                        size="sm"
                      />
                      {nameOf(transfer.fromMemberId)}
                      <ArrowRightIcon width={16} height={16} className="text-muted" />
                      <Avatar
                        name={to?.displayName ?? "?"}
                        position={to?.position ?? 0}
                        size="sm"
                      />
                      {nameOf(transfer.toMemberId)}
                    </p>
                    <div className="flex items-center justify-between gap-3">
                      <span className="num text-lg font-semibold">
                        {formatMoney(transfer.minor, REPORTING_CURRENCY)}
                      </span>
                      <ButtonLink
                        href={`/settlements/new?${query.toString()}`}
                        variant="secondary"
                        className="min-h-9 px-4"
                        aria-label={`Record ${nameOf(transfer.fromMemberId)} paying ${nameOf(transfer.toMemberId)}`}
                      >
                        Record payment
                      </ButtonLink>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 px-1 text-sm text-muted">
              {summary.transfers.length === 1
                ? "One payment settles everything."
                : `${String(summary.transfers.length)} payments settle everything, the fewest possible.`}
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="settlements">
        <SectionTitle id="settlements">Recorded settlements</SectionTitle>
        {ledger.settlements.length === 0 ? (
          <p className="px-1 text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {ledger.settlements.map((settlement) => (
              <SettlementRow
                key={settlement.id}
                settlement={settlement}
                members={ledger.members}
                sgd={priceSettlement(settlement, ledger.book)?.sgdMinor}
                action={
                  <form action={deleteSettlementAction.bind(null, settlement.id)}>
                    <Button type="submit" variant="ghost" className="min-h-9 px-3 text-muted">
                      Delete
                    </Button>
                  </form>
                }
              />
            ))}
          </ul>
        )}
        {deletedSettlements.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer px-1 py-2 text-sm font-medium text-muted">
              Deleted settlements ({deletedSettlements.length})
            </summary>
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
              {deletedSettlements.map((settlement) => (
                <SettlementRow
                  key={settlement.id}
                  settlement={settlement}
                  members={ledger.members}
                  sgd={undefined}
                  deleted
                  action={
                    <form action={restoreSettlementAction.bind(null, settlement.id)}>
                      <Button type="submit" variant="ghost" className="min-h-9 px-3">
                        Restore
                      </Button>
                    </form>
                  }
                />
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function BalanceRow({
  entry,
  member,
  isMe,
  widest,
}: {
  entry: MemberBalance;
  member: Member | undefined;
  isMe: boolean;
  widest: number;
}) {
  const balance = entry.balanceMinor;
  const share = Math.min(50, (Math.abs(balance) / widest) * 50);
  return (
    <li className="px-4 py-3" data-testid="balance-row">
      <div className="flex items-center gap-3">
        <Avatar name={member?.displayName ?? "?"} position={member?.position ?? 0} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {member?.displayName ?? "Someone"}
            {isMe ? (
              <span className="ml-2 align-middle">
                <Pill>You</Pill>
              </span>
            ) : null}
          </p>
          <p className="num text-sm text-muted">
            <span className="whitespace-nowrap">
              Paid {formatMoney(entry.paidMinor, REPORTING_CURRENCY)}
            </span>
            <span aria-hidden="true"> · </span>
            <span className="whitespace-nowrap">
              Share {formatMoney(entry.owedMinor, REPORTING_CURRENCY)}
            </span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={`num font-semibold ${balance > 0 ? "text-positive" : balance < 0 ? "text-negative" : "text-muted"}`}
            data-testid="balance-amount"
          >
            {formatMoney(balance, REPORTING_CURRENCY, { signed: true })}
          </p>
          <p className="text-xs text-muted">
            {balance > 0 ? "gets back" : balance < 0 ? "owes" : "settled up"}
          </p>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-surface-muted"
      >
        {balance !== 0 ? (
          <span
            className={`absolute inset-y-0 rounded-full ${balance > 0 ? "bg-positive" : "bg-negative"}`}
            style={
              balance > 0
                ? { left: "50%", width: `${String(share)}%` }
                : { right: "50%", width: `${String(share)}%` }
            }
          />
        ) : null}
        <span className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
      </div>
    </li>
  );
}

function SettlementRow({
  settlement,
  members,
  sgd,
  action,
  deleted = false,
}: {
  settlement: StoredSettlement;
  members: readonly Member[];
  sgd: number | undefined;
  action: React.ReactNode;
  deleted?: boolean;
}) {
  const nameOf = (userId: string) =>
    members.find((member) => member.userId === userId)?.displayName ?? "Someone";
  const currency = assertCurrencyCode(settlement.currency);
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-testid="settlement-row">
      <div className="min-w-0 flex-1">
        <p className={`truncate font-medium ${deleted ? "text-muted line-through" : ""}`}>
          {nameOf(settlement.fromUserId)} paid {nameOf(settlement.toUserId)}
        </p>
        <p className="truncate text-sm text-muted">
          {formatDate(settlement.settledOn)}
          {settlement.note ? ` · ${settlement.note}` : ""}
        </p>
      </div>
      <div className="num shrink-0 text-right">
        <p className={`font-semibold ${deleted ? "text-muted line-through" : ""}`}>
          {formatMoney(settlement.amountMinor, currency)}
        </p>
        {sgd !== undefined && currency !== REPORTING_CURRENCY ? (
          <p className="text-sm text-muted">{formatMoney(sgd, REPORTING_CURRENCY)}</p>
        ) : null}
      </div>
      {action}
    </li>
  );
}
