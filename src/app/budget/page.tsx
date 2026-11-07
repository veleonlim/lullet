import type { Metadata } from "next";
import { DayBudgetForm, DefaultBudgetForm, TripForm } from "@/components/budget-forms";
import { Button, Card, PageHeader, SectionTitle } from "@/components/ui";
import { SUGGESTED_TIME_ZONES } from "@/lib/dashboard";
import { formatDay, formatMoney, formatPlainAmount, todayIn } from "@/lib/ledger";
import { REPORTING_CURRENCY } from "@/lib/money";
import { openStore } from "@/server/runtime";
import { clearBudgetAction } from "./actions";

export const metadata: Metadata = { title: "Budget" };

export default async function BudgetPage() {
  const store = await openStore();
  const data = await store.loadDashboard();
  const { budgets } = data;
  const overrides = [...budgets.overrides].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const today = todayIn(new Date(), data.timeZone);
  const currentYear = Number(today.slice(0, 4));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget"
        subtitle="One daily budget for the whole group, in SGD. Set a different one for any single day."
        back={{ href: "/dashboard", label: "Dashboard" }}
      />

      <section aria-labelledby="default-budget">
        <SectionTitle id="default-budget">Daily budget</SectionTitle>
        <Card className="space-y-3 p-4">
          <DefaultBudgetForm
            initial={
              budgets.defaultMinor === null
                ? ""
                : formatPlainAmount(budgets.defaultMinor, REPORTING_CURRENCY)
            }
          />
          {budgets.defaultMinor !== null ? (
            <form
              action={clearBudgetAction.bind(null, null)}
              className="border-t border-border pt-3"
            >
              <Button type="submit" variant="ghost" className="min-h-10 px-3 text-muted">
                Remove the daily budget
              </Button>
            </form>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="day-budgets">
        <SectionTitle id="day-budgets">Budgets for single days</SectionTitle>
        {overrides.length > 0 ? (
          <ul
            className="mb-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
            data-testid="day-budgets"
          >
            {overrides.map(([day, amountMinor]) => (
              <li key={day} className="flex items-center gap-3 px-4 py-3" data-testid="day-budget">
                <span className="min-w-0 flex-1 font-medium">{formatDay(day, currentYear)}</span>
                <span className="num font-semibold">
                  {formatMoney(amountMinor, REPORTING_CURRENCY)}
                </span>
                <form action={clearBudgetAction.bind(null, day)}>
                  <Button
                    type="submit"
                    variant="ghost"
                    className="min-h-9 px-3 text-muted"
                    aria-label={`Remove the budget for ${formatDay(day, currentYear)}`}
                  >
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 px-1 text-sm text-muted">
            None yet. Every day uses the daily budget above.
          </p>
        )}
        <Card className="p-4">
          <DayBudgetForm firstDay={today} />
        </Card>
      </section>

      <section aria-labelledby="trip">
        <SectionTitle id="trip">Trip</SectionTitle>
        <Card className="p-4">
          <TripForm
            initial={{
              tripStart: data.tripStart,
              tripEnd: data.tripEnd,
              timeZone: data.timeZone,
            }}
            zones={SUGGESTED_TIME_ZONES}
          />
        </Card>
        <p className="mt-2 px-1 text-sm text-muted">
          The dashboard covers these days. Leave them empty to follow the days that have expenses.
        </p>
      </section>
    </div>
  );
}
