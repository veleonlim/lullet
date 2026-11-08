import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { Pill } from "@/components/ui";
import type { BudgetState, ByCategory } from "@/lib/dashboard";
import { CATEGORIES, formatMoney, type Member } from "@/lib/ledger";
import { REPORTING_CURRENCY } from "@/lib/money";
import { BudgetMeter, BudgetStatePill } from "./budget-meter";
import { CATEGORY_FILL } from "./category-colors";

const sgd = (minor: number) => formatMoney(minor, REPORTING_CURRENCY);

/** A small labelled figure. */
export function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="num mt-0.5 text-lg font-semibold" data-testid={testId}>
        {value}
      </dd>
      {note ? <dd className="num truncate text-xs text-muted">{note}</dd> : null}
    </div>
  );
}

/** Colour key for the categories shown, plus the budget tick when a budget is drawn. */
export function Legend({
  categories,
  showBudget,
}: {
  categories: ByCategory;
  showBudget: boolean;
}) {
  const present = CATEGORIES.filter((category) => categories[category.id] > 0);
  return (
    <ul
      aria-label="Colour key"
      className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted"
      data-testid="legend"
    >
      {present.map((category) => (
        <li key={category.id} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-2.5 rounded-[3px] ${CATEGORY_FILL[category.id]}`}
          />
          {category.label}
        </li>
      ))}
      {showBudget ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-3.5 bg-foreground/70" />
          Daily budget
        </li>
      ) : null}
    </ul>
  );
}

/** Totals by category: a thin segmented bar over a list whose rows carry the figures. */
export function CategoryBreakdown({ byCategory }: { byCategory: ByCategory }) {
  const total = CATEGORIES.reduce((sum, category) => sum + byCategory[category.id], 0);
  const rows = CATEGORIES.filter((category) => byCategory[category.id] > 0);
  if (total === 0) return <p className="px-1 text-sm text-muted">Nothing spent yet.</p>;
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-surface"
      data-testid="category-breakdown"
    >
      <div aria-hidden="true" className="flex h-2 gap-0.5 px-4 pt-4">
        {rows.map((category) => (
          <span
            key={category.id}
            className={`h-2 first:rounded-l-full last:rounded-r-full ${CATEGORY_FILL[category.id]}`}
            style={{ flexGrow: byCategory[category.id], flexBasis: 0 }}
          />
        ))}
      </div>
      <ul className="divide-y divide-border">
        {rows.map((category) => (
          <li
            key={category.id}
            className="flex items-center gap-3 px-4 py-3"
            data-testid="category-row"
            data-category={category.id}
          >
            <span
              aria-hidden="true"
              className={`size-3 shrink-0 rounded-[3px] ${CATEGORY_FILL[category.id]}`}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{category.label}</span>
            <span className="num text-sm text-muted">
              {String(Math.round((byCategory[category.id] * 100) / total))}%
            </span>
            <span className="num w-24 text-right font-semibold" data-testid="category-amount">
              {sgd(byCategory[category.id])}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface PersonLine {
  readonly member: Member;
  readonly isMe: boolean;
  readonly spentMinor: number;
  readonly budgetMinor: number | null;
  readonly state: BudgetState;
  /** Shown under the name, e.g. "Trip total S$120.00". */
  readonly note?: string;
}

/** One row per member: their share against the budget divided by the members. */
export function PersonBreakdown({
  lines,
  caption,
}: {
  lines: readonly PersonLine[];
  caption: string;
}) {
  return (
    <ul
      aria-label={caption}
      className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
    >
      {lines.map((line) => (
        <li
          key={line.member.userId}
          className="px-4 py-3"
          data-testid="person-row"
          data-member={line.member.displayName}
        >
          <div className="flex items-center gap-3">
            <Avatar name={line.member.displayName} position={line.member.position} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {line.member.displayName}
                {line.isMe ? (
                  <span className="ml-2 align-middle">
                    <Pill>You</Pill>
                  </span>
                ) : null}
              </p>
              <p className="num truncate text-sm text-muted">
                {line.budgetMinor === null ? "No budget set" : `of ${sgd(line.budgetMinor)}`}
              </p>
              {line.note ? <p className="num truncate text-xs text-muted">{line.note}</p> : null}
            </div>
            <div className="shrink-0 text-right">
              <p className="num font-semibold" data-testid="person-spent">
                {sgd(line.spentMinor)}
              </p>
              <BudgetStatePill state={line.state} />
            </div>
          </div>
          {line.budgetMinor !== null ? (
            <div className="mt-3">
              <BudgetMeter
                spentMinor={line.spentMinor}
                budgetMinor={line.budgetMinor}
                state={line.state}
                label={`${line.member.displayName}'s share`}
                size="sm"
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
