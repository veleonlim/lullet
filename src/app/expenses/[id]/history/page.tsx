import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { Card, PageHeader, Pill } from "@/components/ui";
import {
  auditActionLabel,
  describeExpenseChanges,
  expenseSnapshotSchema,
  type Change,
} from "@/lib/ledger";
import { NotFoundError } from "@/server/ledger";
import { openStore } from "@/server/runtime";

export const metadata: Metadata = { title: "Expense history" };

export default async function ExpenseHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const store = await openStore();
  const { id } = await params;
  const expense = await store.getExpense(id);
  if (!expense) notFound();
  const members = await store.members();
  const nameOf = (userId: string) =>
    members.find((member) => member.userId === userId)?.displayName ?? "Someone";

  let history;
  try {
    history = await store.expenseHistory(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  // Newest first reads best for "what just happened"; the data layer returns oldest first.
  const entries = [...history].reverse().map((entry) => ({
    entry,
    changes: changesOf(entry.action, entry.before, entry.after, nameOf),
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="History"
        subtitle={expense.description}
        back={{ href: `/expenses/${id}`, label: "Expense" }}
      />
      <ol className="space-y-3">
        {entries.map(({ entry, changes }) => (
          <li key={entry.id}>
            <Card className="p-4" data-testid="history-entry">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-medium">
                  <span data-testid="history-actor">
                    {entry.actorUserId ? nameOf(entry.actorUserId) : "The system"}
                  </span>{" "}
                  <Pill>{auditActionLabel(entry.action)}</Pill>
                </p>
                <LocalTime iso={entry.createdAt.toISOString()} className="text-sm text-muted" />
              </div>
              {changes.length > 0 ? (
                <dl className="mt-3 space-y-2 text-sm">
                  {changes.map((change) => (
                    <div
                      key={change.label}
                      className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3"
                    >
                      <dt className="text-muted">{change.label}</dt>
                      <dd className="min-w-0 break-words">
                        {change.from !== null ? (
                          <span className="text-muted line-through">{change.from}</span>
                        ) : null}
                        {change.from !== null && change.to !== null ? (
                          <span aria-hidden="true" className="px-1.5 text-muted">
                            →
                          </span>
                        ) : null}
                        {change.to !== null ? (
                          <span className="font-medium">{change.to}</span>
                        ) : (
                          <span className="sr-only"> removed</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What to list under an entry: every fact when added, only the differences when edited. */
function changesOf(
  action: string,
  before: unknown,
  after: unknown,
  nameOf: (userId: string) => string,
): Change[] {
  if (action !== "expense.create" && action !== "expense.update") return [];
  const left = expenseSnapshotSchema.safeParse(before);
  const right = expenseSnapshotSchema.safeParse(after);
  return describeExpenseChanges(
    left.success ? left.data : null,
    right.success ? right.data : null,
    nameOf,
  );
}
