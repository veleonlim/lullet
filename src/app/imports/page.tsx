import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { ButtonLink, Card, PageHeader, Pill } from "@/components/ui";
import type { ImportStatus } from "@/lib/import";
import { route } from "@/lib/routes";
import { openImportStore } from "@/server/import/runtime";

export const metadata: Metadata = { title: "Imports" };

const STATUS: Record<ImportStatus, { label: string; tone: "neutral" | "positive" | "warning" }> = {
  draft: { label: "Waiting for review", tone: "warning" },
  confirmed: { label: "Added", tone: "positive" },
  undone: { label: "Undone", tone: "neutral" },
  cancelled: { label: "Discarded", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

export default async function ImportsPage() {
  const store = await openImportStore();
  const [imports, members] = await Promise.all([store.listRecent(30), store.members()]);
  const nameOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.displayName ?? "Someone";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Screenshot imports"
        back={{ href: "/expenses", label: "Expenses" }}
        actions={
          <ButtonLink href="/imports/new" variant="primary">
            Import screenshot
          </ButtonLink>
        }
      />
      {imports.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="font-medium">No imports yet</p>
          <p className="max-w-xs text-sm text-muted">
            Upload a screenshot of your bank app and lullet turns it into expenses to check.
          </p>
          <ButtonLink href="/imports/new" variant="primary">
            Import a screenshot
          </ButtonLink>
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {imports.map((item) => (
            <Link
              key={item.id}
              href={route(`/imports/${item.id}`)}
              data-testid="import-item"
              className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
            >
              <span className="min-w-0">
                <span className="block font-medium">
                  {nameOf(item.uploaderId)}&apos;s screenshot
                </span>
                <span className="block text-sm text-muted">
                  <LocalTime iso={item.createdAt.toISOString()} />
                  {item.status === "draft" || item.status === "confirmed"
                    ? ` · ${String(item.rowCount)} ${item.rowCount === 1 ? "payment" : "payments"}`
                    : ""}
                </span>
              </span>
              <Pill tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Pill>
            </Link>
          ))}
        </Card>
      )}
      <div className="sm:hidden">
        <ButtonLink href="/imports/new" variant="primary" className="w-full">
          Import screenshot
        </ButtonLink>
      </div>
    </div>
  );
}
