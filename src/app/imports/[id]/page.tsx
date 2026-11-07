import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ImportResult } from "@/components/import/result";
import { ImportReview } from "@/components/import/review";
import { ButtonLink, Notice, PageHeader } from "@/components/ui";
import { openImportStore } from "@/server/import/runtime";

export const metadata: Metadata = { title: "Review import" };

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const store = await openImportStore();
  const { id } = await params;
  const view = await store.getDraft(id);
  if (!view) notFound();
  const members = await store.members();
  const currentUserId = store.session.userId;

  if (view.status === "draft") {
    return (
      <>
        <PageHeader title="Review import" back={{ href: "/expenses", label: "Expenses" }} />
        <ImportReview view={view} members={members} currentUserId={currentUserId} />
      </>
    );
  }

  if (view.status === "confirmed" || view.status === "undone") {
    return (
      <>
        <PageHeader
          title={view.status === "undone" ? "Import undone" : "Import added"}
          back={{ href: "/expenses", label: "Expenses" }}
        />
        <ImportResult view={view} members={members} currentUserId={currentUserId} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={view.status === "expired" ? "Draft expired" : "Import discarded"}
        back={{ href: "/expenses", label: "Expenses" }}
      />
      <div className="space-y-4">
        <Notice tone="info" role="status">
          {view.status === "expired"
            ? "This draft was not added within 24 hours, so it was discarded. Nothing was added to the ledger."
            : "This import was discarded. Nothing was added to the ledger."}
        </Notice>
        <ButtonLink href="/imports/new" variant="primary">
          Import a screenshot
        </ButtonLink>
      </div>
    </>
  );
}
