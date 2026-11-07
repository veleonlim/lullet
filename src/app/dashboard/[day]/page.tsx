import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BudgetMeter, BudgetStatePill } from "@/components/dashboard/budget-meter";
import { CategoryBreakdown, PersonBreakdown, type PersonLine } from "@/components/dashboard/parts";
import { ExpenseRow } from "@/components/expense-row";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { Card, Notice, PageHeader, Pill, SectionTitle } from "@/components/ui";
import { addDays, scopedDay } from "@/lib/dashboard";
import { formatDay, formatMoney } from "@/lib/ledger";
import { isIsoDate, REPORTING_CURRENCY } from "@/lib/money";
import { route } from "@/lib/routes";
import { loadDashboardModel } from "@/server/dashboard";
import { openStore } from "@/server/runtime";

export const metadata: Metadata = { title: "Day" };

const sgd = (minor: number) => formatMoney(minor, REPORTING_CURRENCY);

const SOURCE_TEXT = {
  default: "The default daily budget",
  override: "A budget set for this day",
  none: "",
} as const;

export default async function DayPage({ params }: { params: Promise<{ day: string }> }) {
  const { day } = await params;
  if (!isIsoDate(day)) notFound();
  const store = await openStore();
  const { model } = await loadDashboardModel(store);
  const bucket = model.days.find((candidate) => candidate.date === day);
  if (!bucket) notFound();

  const me = store.session.userId;
  const currentYear = Number(model.today.slice(0, 4));
  const total = scopedDay(bucket, null);
  const upcoming = bucket.timing === "future" && bucket.totalMinor === 0;
  const first = model.days[0]?.date;
  const last = model.days[model.days.length - 1]?.date;
  const previous = first !== undefined && day > first ? addDays(day, -1) : null;
  const next = last !== undefined && day < last ? addDays(day, 1) : null;

  const lines: PersonLine[] = model.members.map((member) => {
    const share = scopedDay(bucket, member.userId);
    return {
      member,
      isMe: member.userId === me,
      spentMinor: share.spentMinor,
      budgetMinor: share.budgetMinor,
      state: upcoming ? "under" : share.state,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={formatDay(day, currentYear)}
        subtitle={bucket.timing === "today" ? "Today" : undefined}
        back={{ href: "/dashboard", label: "Dashboard" }}
      />

      <nav aria-label="Other days" className="-mt-2 flex items-center justify-between gap-3">
        <DayLink day={previous} direction="previous" />
        <DayLink day={next} direction="next" />
      </nav>

      {bucket.unpricedCount > 0 ? (
        <Notice tone="warning">
          {bucket.unpricedCount === 1
            ? "One expense on this day has no exchange rate yet, so it is left out of these figures."
            : `${String(bucket.unpricedCount)} expenses on this day have no exchange rate yet, so they are left out of these figures.`}{" "}
          <Link href="/rates" className="font-semibold underline">
            Set a day rate
          </Link>
        </Notice>
      ) : null}

      <Card className="space-y-3 p-4 sm:p-5" aria-label="Day total" data-testid="day-summary">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">Spent</p>
            <p className="num mt-1 text-3xl font-semibold tracking-tight" data-testid="day-total">
              {sgd(bucket.totalMinor)}
            </p>
            <p className="num mt-0.5 text-sm text-muted">
              {bucket.budgetMinor === null
                ? "No budget for this day"
                : `of ${sgd(bucket.budgetMinor)} · ${SOURCE_TEXT[bucket.budgetSource]}`}
            </p>
          </div>
          {bucket.budgetMinor !== null ? (
            <BudgetStatePill state={total.state} upcoming={upcoming} />
          ) : null}
        </div>
        {bucket.budgetMinor !== null ? (
          <BudgetMeter
            spentMinor={bucket.totalMinor}
            budgetMinor={bucket.budgetMinor}
            state={upcoming ? "under" : total.state}
            label={formatDay(day, currentYear)}
          />
        ) : null}
        <p className="text-sm">
          <Link href="/budget" className="font-medium text-accent">
            {bucket.budgetMinor === null ? "Set a budget" : "Change the budget"}
          </Link>
        </p>
      </Card>

      <section aria-labelledby="day-people">
        <SectionTitle id="day-people">Each person&apos;s share</SectionTitle>
        <PersonBreakdown lines={lines} caption="Each person's share of this day" />
      </section>

      <section aria-labelledby="day-categories">
        <SectionTitle id="day-categories">By category</SectionTitle>
        <CategoryBreakdown byCategory={bucket.byCategory} />
      </section>

      <section aria-labelledby="day-expenses">
        <SectionTitle id="day-expenses">
          Expenses{" "}
          <Pill>
            <span data-testid="day-expense-count">{String(bucket.expenses.length)}</span>
          </Pill>
        </SectionTitle>
        {bucket.expenses.length === 0 ? (
          <p className="px-1 text-sm text-muted">Nothing was spent on this day.</p>
        ) : (
          <ul
            className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
            data-testid="day-expenses"
          >
            {bucket.expenses.map((item) => (
              <ExpenseRow key={item.expense.id} priced={item} members={model.members} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DayLink({ day, direction }: { day: string | null; direction: "previous" | "next" }) {
  if (day === null) return <span />;
  return (
    <Link
      href={route(`/dashboard/${day}`)}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-medium text-muted hover:text-foreground"
    >
      {direction === "previous" ? <ChevronLeftIcon width={18} height={18} /> : null}
      {formatDay(day)}
      {direction === "next" ? <ChevronRightIcon width={18} height={18} /> : null}
    </Link>
  );
}
