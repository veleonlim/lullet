import type { Metadata } from "next";
import { PageHeader, SignedOut } from "@/components/ui";
import { SettlementForm } from "@/components/settlement-form";
import { blankSettlementForm, todayIn } from "@/lib/ledger";
import { openStore } from "@/server/runtime";

export const metadata: Metadata = { title: "Record settlement" };

export default async function NewSettlementPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; amount?: string }>;
}) {
  const store = await openStore();
  if (!store) return <SignedOut />;
  const params = await searchParams;
  const members = await store.members();

  // A suggested payment arrives pre-filled; anything unknown falls back to sensible people.
  const known = (id: string | undefined) => members.find((member) => member.userId === id)?.userId;
  const fromUserId = known(params.from) ?? store.session.userId;
  const toUserId =
    known(params.to) ??
    members.find((member) => member.userId !== fromUserId)?.userId ??
    fromUserId;
  const today = todayIn(new Date());

  return (
    <>
      <PageHeader title="Record settlement" back={{ href: "/balances", label: "Balances" }} />
      <SettlementForm
        members={members}
        initial={blankSettlementForm({
          fromUserId,
          toUserId,
          amount: /^\d+(\.\d{1,2})?$/.test(params.amount ?? "") ? params.amount : undefined,
          today,
        })}
        serverToday={today}
        freshDate
      />
    </>
  );
}
