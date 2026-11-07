import type { Metadata } from "next";
import Link from "next/link";
import { DayRateControls } from "@/components/day-rate-row";
import { ChevronRightIcon } from "@/components/icons";
import { Card, PageHeader, Pill } from "@/components/ui";
import { convertedCurrency, usesDayRate } from "@/lib/dashboard";
import { formatDay } from "@/lib/ledger";
import { isCurrencyCode, REPORTING_CURRENCY, type CurrencyCode } from "@/lib/money";
import { route } from "@/lib/routes";
import { loadDashboardModel } from "@/server/dashboard";
import { openStore } from "@/server/runtime";

export const metadata: Metadata = { title: "Exchange rates" };

/** The trip's currencies are always offered, then any other the ledger already uses. */
const ALWAYS_OFFERED: readonly CurrencyCode[] = ["EUR", "CHF"];

export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string }>;
}) {
  const store = await openStore();
  const params = await searchParams;
  const { model, data } = await loadDashboardModel(store);

  const used = new Set<CurrencyCode>(ALWAYS_OFFERED);
  for (const expense of data.expenses) {
    const currency = convertedCurrency(expense);
    if (currency !== REPORTING_CURRENCY) used.add(currency);
  }
  const currencies = [...used].sort((a, b) => {
    const rank = (code: CurrencyCode) => {
      const index = ALWAYS_OFFERED.indexOf(code);
      return index === -1 ? ALWAYS_OFFERED.length : index;
    };
    return rank(a) - rank(b) || (a < b ? -1 : 1);
  });
  const requested = params.currency;
  const currency: CurrencyCode =
    requested !== undefined && isCurrencyCode(requested) && used.has(requested)
      ? requested
      : (currencies[0] ?? "EUR");

  const [mine, market] = await Promise.all([
    store.listDayRates(currency),
    store.listMarketRates(currency, model.range.start, model.range.end),
  ]);
  const mineByDay = new Map(mine.map((row) => [row.day, row.rate]));
  const marketByDay = new Map(market.map((row) => [row.day, row.rate]));
  const currentYear = Number(model.today.slice(0, 4));

  const rows = [...model.days].reverse().map((day) => {
    const onDay = data.expenses.filter((expense) => expense.spentOn === day.date);
    return {
      day: day.date,
      timing: day.timing,
      override: mineByDay.get(day.date) ?? null,
      market: marketByDay.get(day.date) ?? null,
      count: onDay.filter((expense) => convertedCurrency(expense) === currency).length,
      affected: onDay.filter((expense) => usesDayRate(expense, currency)).length,
    };
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Exchange rates"
        subtitle={`Your default rate for each day, in SGD per 1 ${currency}. Tap a day to set it.`}
      />

      <nav aria-label="Currency" className="flex flex-wrap gap-2">
        {currencies.map((code) => (
          <Link
            key={code}
            href={route(`/rates?currency=${code}`)}
            aria-current={code === currency ? "page" : undefined}
            className={`inline-flex min-h-9 items-center rounded-full px-4 text-sm font-medium ${
              code === currency
                ? "bg-foreground text-background"
                : "bg-surface-muted text-muted hover:text-foreground"
            }`}
          >
            {code}
          </Link>
        ))}
      </nav>

      <p className="px-1 text-sm text-muted">
        Saving a rate does not change existing expenses: they keep their figures until you re-price
        the day, and each change is kept in the expense&apos;s history. New expenses use the rate as
        it is when they are saved.
      </p>

      <ul
        className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
        data-testid="rate-days"
      >
        {rows.map((row) => (
          <li key={row.day} data-testid="rate-day" data-day={row.day}>
            <details className="group">
              <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon
                  width={18}
                  height={18}
                  className="shrink-0 text-muted transition-transform group-open:rotate-90"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {formatDay(row.day, currentYear)}
                  </span>
                  <span className="block text-sm text-muted">
                    {row.count === 0
                      ? `No ${currency} expenses`
                      : `${String(row.count)} ${currency} ${row.count === 1 ? "expense" : "expenses"}`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="num block font-semibold" data-testid="effective-rate">
                    {row.override ?? row.market ?? "-"}
                  </span>
                  <span className="block">
                    {row.override ? (
                      <Pill tone="positive">Your rate</Pill>
                    ) : row.market ? (
                      <Pill>Market</Pill>
                    ) : (
                      <Pill tone={row.count > 0 ? "warning" : "neutral"}>No rate</Pill>
                    )}
                  </span>
                </span>
              </summary>
              <DayRateControls
                day={row.day}
                currency={currency}
                override={row.override}
                market={row.market}
                affected={row.affected}
              />
            </details>
          </li>
        ))}
      </ul>

      <Card className="p-4 text-sm text-muted">
        A rate typed on a single expense, or an exact SGD figure the bank billed, always beats the
        day&apos;s rate. The order is: billed SGD, the expense&apos;s own rate, the day&apos;s rate,
        the market rate.
      </Card>
    </div>
  );
}
