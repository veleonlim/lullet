import type { Metadata } from "next";
import Link from "next/link";
import { BudgetMeter, BudgetStatePill } from "@/components/dashboard/budget-meter";
import { DayChart } from "@/components/dashboard/day-chart";
import {
  CategoryBreakdown,
  Legend,
  PersonBreakdown,
  Stat,
  type PersonLine,
} from "@/components/dashboard/parts";
import { ButtonLink, Card, Notice, PageHeader, Pill, SectionTitle } from "@/components/ui";
import { daysSoFar, rollup, scopedDay, type ByCategory, type ScopedDay } from "@/lib/dashboard";
import { CATEGORY_IDS, formatDay, formatMoney } from "@/lib/ledger";
import { REPORTING_CURRENCY } from "@/lib/money";
import { route } from "@/lib/routes";
import { loadDashboardModel } from "@/server/dashboard";
import { openStore } from "@/server/runtime";

export const metadata: Metadata = { title: "Dashboard" };

const sgd = (minor: number) => formatMoney(minor, REPORTING_CURRENCY);

function sumCategories(days: readonly ScopedDay[]): ByCategory {
  const totals = Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0])) as ByCategory;
  for (const day of days) for (const id of CATEGORY_IDS) totals[id] += day.byCategory[id];
  return totals;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string }>;
}) {
  const store = await openStore();
  const params = await searchParams;
  const { model } = await loadDashboardModel(store);
  const me = store.session.userId;

  const chosen = model.members.find((member) => member.userId === params.person);
  const scope = chosen?.userId ?? null;
  const scopeName = chosen ? chosen.displayName : "Everyone";

  const days = model.days.map((day) => scopedDay(day, scope));
  const sofar = rollup(daysSoFar(days));
  const whole = rollup(days);
  const today = days.find((day) => day.date === model.today);
  const currentYear = Number(model.today.slice(0, 4));
  const categories = sumCategories(days);
  const spentAnything = whole.spentMinor > 0;

  const personLines: PersonLine[] = model.members.map((member) => {
    const mine = model.days.map((day) => scopedDay(day, member.userId));
    const so = rollup(daysSoFar(mine));
    return {
      member,
      isMe: member.userId === me,
      spentMinor: so.spentMinor,
      budgetMinor: so.budgetMinor,
      state: so.state,
      // Only worth saying when days still to come already carry spending.
      ...(rollup(mine).spentMinor === so.spentMinor
        ? {}
        : { note: `Trip total ${sgd(rollup(mine).spentMinor)}` }),
    };
  });

  const remaining = sofar.remainingMinor;
  // Days still to come with nothing on them stay in the chart but not in the list.
  const isComingUp = (day: ScopedDay) => day.timing === "future" && day.spentMinor === 0;
  const listed = days.filter((day) => !isComingUp(day)).reverse();
  const comingUp = days.filter(isComingUp);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Spending per day in SGD. Each person's figure is their share, not what they paid."
        actions={
          <ButtonLink href="/budget" variant="secondary">
            Budget
          </ButtonLink>
        }
      />

      {model.unpricedCount > 0 ? (
        <Notice tone="warning">
          {model.unpricedCount === 1
            ? "One expense has no exchange rate yet, so it is left out of every figure here."
            : `${String(model.unpricedCount)} expenses have no exchange rate yet, so they are left out of every figure here.`}{" "}
          <Link href="/rates" className="font-semibold underline">
            Set a day rate
          </Link>
        </Notice>
      ) : null}

      <nav aria-label="Whose spending" className="-mt-1 flex flex-wrap gap-2">
        <FilterChip href="/dashboard" active={scope === null}>
          Everyone
        </FilterChip>
        {model.members.map((member) => (
          <FilterChip
            key={member.userId}
            href={`/dashboard?person=${member.userId}`}
            active={scope === member.userId}
          >
            {member.displayName}
          </FilterChip>
        ))}
      </nav>

      <Card className="space-y-4 p-4 sm:p-5" aria-label="Trip so far" data-testid="summary">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {scope === null ? "Trip so far" : `${scopeName}'s share so far`}
            </p>
            <p
              className="num mt-1 text-3xl font-semibold tracking-tight"
              data-testid="spent-so-far"
            >
              {sgd(sofar.spentMinor)}
            </p>
            <p className="num mt-0.5 text-sm text-muted">
              {sofar.budgetMinor === null
                ? `over ${String(sofar.days)} ${sofar.days === 1 ? "day" : "days"}`
                : `of ${sgd(sofar.budgetMinor)} budget over ${String(sofar.days)} ${sofar.days === 1 ? "day" : "days"}`}
            </p>
          </div>
          {sofar.budgetMinor !== null ? <BudgetStatePill state={sofar.state} /> : null}
        </div>

        {sofar.budgetMinor !== null && remaining !== null ? (
          <div className="space-y-2">
            <BudgetMeter
              spentMinor={sofar.spentMinor}
              budgetMinor={sofar.budgetMinor}
              state={sofar.state}
              label="Trip so far"
            />
            <p
              className={`num text-sm font-medium ${remaining < 0 ? "text-negative" : "text-positive"}`}
              data-testid="remaining"
            >
              {remaining < 0 ? `${sgd(-remaining)} over budget` : `${sgd(remaining)} left`}
            </p>
          </div>
        ) : (
          <Notice>
            No daily budget yet.{" "}
            <Link href="/budget" className="font-semibold underline">
              Set one
            </Link>{" "}
            to see how spending compares.
          </Notice>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-4">
          <Stat
            label="Today"
            value={today ? sgd(today.spentMinor) : "-"}
            note={
              today
                ? today.budgetMinor === null
                  ? "no budget"
                  : `of ${sgd(today.budgetMinor)}`
                : "not a trip day"
            }
            testId="today-spent"
          />
          <Stat label="Average a day" value={sgd(sofar.averageMinor)} testId="average" />
          <Stat
            label="Days over"
            value={String(sofar.daysOver)}
            note={sofar.budgetedDays === 0 ? "no budget" : `of ${String(sofar.budgetedDays)}`}
            testId="days-over"
          />
          <Stat label="Whole trip" value={sgd(whole.spentMinor)} testId="trip-total" />
        </dl>
      </Card>

      <section aria-labelledby="by-day">
        <SectionTitle id="by-day">Day by day</SectionTitle>
        {spentAnything || model.days.length > 0 ? (
          <Card className="p-4">
            <DayChart
              days={days}
              today={model.today}
              title={`Spending per day, ${scopeName.toLowerCase()}`}
            />
            <Legend categories={categories} showBudget={model.hasBudget} />
          </Card>
        ) : null}
        <ul
          className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
          aria-label="Days, newest first"
        >
          {listed.map((day) => (
            <DayRow key={day.date} day={day} today={model.today} currentYear={currentYear} />
          ))}
        </ul>
        {comingUp.length > 0 ? (
          <p className="mt-2 px-1 text-sm text-muted" data-testid="coming-up">
            {comingUp.length === 1
              ? `One more day to come, ${formatDay(comingUp[0]?.date ?? "", currentYear)}.`
              : `${String(comingUp.length)} more days to come, until ${formatDay(comingUp[comingUp.length - 1]?.date ?? "", currentYear)}.`}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="by-person">
        <SectionTitle id="by-person">Each person&apos;s share</SectionTitle>
        <PersonBreakdown lines={personLines} caption="Each person's share so far" />
        <p className="mt-2 px-1 text-sm text-muted">
          Compared with the daily budget divided by {String(model.members.length)}.
        </p>
      </section>

      <section aria-labelledby="by-category">
        <SectionTitle id="by-category">By category</SectionTitle>
        <CategoryBreakdown byCategory={categories} />
      </section>

      <p className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-sm">
        <Link href="/budget" className="font-medium text-accent">
          Budget and trip dates
        </Link>
        <Link href="/rates" className="font-medium text-accent">
          Daily exchange rates
        </Link>
      </p>
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={route(href)}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full px-4 text-sm font-medium ${
        active
          ? "bg-foreground text-background"
          : "bg-surface-muted text-muted hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

function DayRow({
  day,
  today,
  currentYear,
}: {
  day: ScopedDay;
  today: string;
  currentYear: number;
}) {
  const upcoming = day.timing === "future" && day.spentMinor === 0;
  return (
    <li>
      <Link
        href={route(`/dashboard/${day.date}`)}
        data-testid="day-row"
        data-day={day.date}
        className="block min-h-16 px-4 py-3 transition-colors hover:bg-surface-muted active:bg-surface-muted"
      >
        <span className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 pt-0.5 font-medium">
            <span className="truncate">{formatDay(day.date, currentYear)}</span>
            {day.date === today ? <Pill>Today</Pill> : null}
          </span>
          <span className="shrink-0 text-right">
            <span className="num block font-semibold" data-testid="day-spent">
              {sgd(day.spentMinor)}
            </span>
            {day.budgetMinor !== null ? (
              <span className="num block text-xs text-muted">of {sgd(day.budgetMinor)}</span>
            ) : null}
          </span>
        </span>
        {day.budgetMinor !== null ? (
          <span className="mt-2 grid grid-cols-[minmax(0,1fr)_4.75rem] items-center gap-3">
            <BudgetMeter
              spentMinor={day.spentMinor}
              budgetMinor={day.budgetMinor}
              state={upcoming ? "under" : day.state}
              label={formatDay(day.date, currentYear)}
              size="sm"
            />
            <span className="text-right">
              <BudgetStatePill state={day.state} upcoming={upcoming} />
            </span>
          </span>
        ) : null}
      </Link>
    </li>
  );
}
