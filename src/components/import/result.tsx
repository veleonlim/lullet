import Link from "next/link";
import { LocalTime } from "../local-time";
import { Card, Notice, SectionTitle } from "../ui";
import { UndoImportButton } from "./undo-button";
import { formatDate, formatMoney, type Member } from "@/lib/ledger";
import type { DraftView } from "@/lib/import";
import { isCurrencyCode } from "@/lib/money";
import { route } from "@/lib/routes";

/** A finished import: what it added (or that it was undone), with Undo import for the uploader. */
export function ImportResult({
  view,
  members,
  currentUserId,
}: {
  view: DraftView;
  members: readonly Member[];
  currentUserId: string;
}) {
  const uploader = members.find((m) => m.userId === view.uploaderId)?.displayName ?? "Someone";
  const live = view.expenses.filter((e) => e.deletedAt === null);
  const undone = view.status === "undone";

  return (
    <div className="space-y-5">
      {undone ? (
        <Notice tone="warning" role="status">
          This import was undone
          {view.undoneAt ? (
            <>
              {" "}
              on <LocalTime iso={view.undoneAt.toISOString()} />
            </>
          ) : null}
          . Its expenses are in the Deleted list on the Expenses page, where each can be restored.
        </Notice>
      ) : (
        <Notice tone="success" role="status">
          Added {live.length} {live.length === 1 ? "expense" : "expenses"} from {uploader}&apos;s
          screenshot
          {view.confirmedAt ? (
            <>
              {" "}
              on <LocalTime iso={view.confirmedAt.toISOString()} />
            </>
          ) : null}
          .
        </Notice>
      )}

      <section aria-labelledby="added" className="space-y-2">
        <SectionTitle id="added">{undone ? "Removed" : "Added to the ledger"}</SectionTitle>
        <Card className="divide-y divide-border">
          {view.expenses.map((expense) => (
            <Link
              key={expense.id}
              href={route(`/expenses/${expense.id}`)}
              data-testid="imported-expense"
              className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-surface-muted"
            >
              <span className="min-w-0">
                <span
                  className={`block truncate font-medium ${expense.deletedAt ? "text-muted line-through" : ""}`}
                >
                  {expense.description}
                </span>
                <span className="block text-sm text-muted">{formatDate(expense.spentOn)}</span>
              </span>
              <span className="num shrink-0 font-semibold">
                {isCurrencyCode(expense.currency)
                  ? formatMoney(expense.amountMinor, expense.currency)
                  : String(expense.amountMinor)}
              </span>
            </Link>
          ))}
        </Card>
      </section>

      {view.imageAvailable ? (
        <details className="rounded-2xl border border-border bg-surface">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-semibold">
            Original screenshot
          </summary>
          <div className="border-t border-border p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/imports/${view.id}/image`}
              alt="The uploaded screenshot"
              loading="lazy"
              className="mx-auto max-h-96 w-auto max-w-full rounded-lg object-contain"
            />
          </div>
        </details>
      ) : (
        <p className="text-sm text-muted">
          The original screenshot has been deleted. The extracted rows are kept.
        </p>
      )}

      {view.status === "confirmed" && view.uploaderId === currentUserId ? (
        <UndoImportButton importId={view.id} count={live.length} />
      ) : null}
    </div>
  );
}
