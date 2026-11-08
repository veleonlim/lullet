import Link from "next/link";
import { CATEGORIES, formatDay, formatMoney, type CategoryId } from "@/lib/ledger";
import { formatAxisMoney, labelEvery, niceCeiling, type ScopedDay } from "@/lib/dashboard";
import { REPORTING_CURRENCY } from "@/lib/money";
import { route } from "@/lib/routes";
import { CATEGORY_FILL } from "./category-colors";

const STATE_WORDS = {
  none: "",
  under: ", under budget",
  near: ", near budget",
  over: ", over budget",
};

/** Day of the month, with the month on the first label and whenever the month changes. */
function shortLabel(date: string, previous: string | undefined): string {
  const [, month = "1", day = "1"] = date.split("-");
  const monthName = formatDay(date).split(" ")[2] ?? "";
  return previous?.slice(5, 7) !== month
    ? `${String(Number(day))} ${monthName}`
    : String(Number(day));
}

/**
 * Spending per day as stacked columns, one colour per category, with each day's budget marked
 * across its column. Hand-rolled HTML and CSS rather than a chart library: nothing to ship to
 * the phone, text stays crisp at any width, and the colours come straight from the theme
 * tokens so light and dark always agree. Every column is a link to its day; the day list
 * below the chart carries the same figures as text.
 */
export function DayChart({
  days,
  today,
  title,
}: {
  days: readonly ScopedDay[];
  today: string;
  /** Names the chart for assistive technology, e.g. "Spending per day, everyone". */
  title: string;
}) {
  const peak = Math.max(0, ...days.map((day) => Math.max(day.spentMinor, day.budgetMinor ?? 0)));
  const ceiling = niceCeiling(peak);
  const every = labelEvery(days.length);
  const gridlines = [0, 0.5, 1];

  return (
    <figure aria-label={title} data-testid="day-chart">
      <div className="flex gap-2">
        <div aria-hidden="true" className="relative h-44 w-12 shrink-0">
          {gridlines.map((fraction) => (
            <span
              key={fraction}
              className="num absolute right-0 translate-y-1/2 text-xs text-muted"
              style={{ bottom: `${String(fraction * 100)}%` }}
            >
              {formatAxisMoney(Math.round(ceiling * fraction))}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ minWidth: `${String(days.length * 14)}px` }}>
            <div className="relative h-44">
              {gridlines.map((fraction) => (
                <span
                  key={fraction}
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-border"
                  style={{ bottom: `${String(fraction * 100)}%` }}
                />
              ))}
              <ol className="absolute inset-0 flex gap-[3px]">
                {days.map((day) => (
                  <li key={day.date} className="relative min-w-0 flex-1">
                    <Column day={day} ceiling={ceiling} isToday={day.date === today} />
                  </li>
                ))}
              </ol>
            </div>
            <div aria-hidden="true" className="relative mt-1.5 h-4">
              {days.map((day, index) =>
                index % every === 0 ? (
                  <span
                    key={day.date}
                    className={`num absolute -translate-x-1/2 text-xs whitespace-nowrap ${
                      day.date === today ? "font-semibold text-accent" : "text-muted"
                    }`}
                    style={{ left: `${String(((index + 0.5) / days.length) * 100)}%` }}
                  >
                    {shortLabel(day.date, days[index - every]?.date)}
                  </span>
                ) : null,
              )}
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

function Column({ day, ceiling, isToday }: { day: ScopedDay; ceiling: number; isToday: boolean }) {
  const present = CATEGORIES.filter((category) => day.byCategory[category.id] > 0);
  const topId = present[present.length - 1]?.id;
  const label = `${formatDay(day.date)}: ${formatMoney(day.spentMinor, REPORTING_CURRENCY)}${
    day.timing === "future" && day.spentMinor === 0 ? ", upcoming" : STATE_WORDS[day.state]
  }`;
  const detail = present
    .map(
      (category) =>
        `${category.label} ${formatMoney(day.byCategory[category.id], REPORTING_CURRENCY)}`,
    )
    .join(", ");

  return (
    <Link
      href={route(`/dashboard/${day.date}`)}
      tabIndex={-1}
      aria-label={label}
      title={detail === "" ? label : `${label} (${detail})`}
      data-day={day.date}
      data-spent={day.spentMinor}
      aria-current={isToday ? "date" : undefined}
      className={`absolute inset-0 flex flex-col-reverse rounded-sm transition-colors hover:bg-surface-muted ${
        day.timing === "future" ? "opacity-60" : ""
      }`}
    >
      {CATEGORIES.map((category) => {
        const minor = day.byCategory[category.id];
        if (minor <= 0) return null;
        return (
          <Segment
            key={category.id}
            id={category.id}
            percent={(minor / ceiling) * 100}
            top={category.id === topId}
          />
        );
      })}
      {day.budgetMinor !== null ? (
        <span
          aria-hidden="true"
          data-testid="budget-mark"
          className="pointer-events-none absolute inset-x-0 h-0.5 bg-foreground/70"
          style={{ bottom: `calc(${String((day.budgetMinor / ceiling) * 100)}% - 1px)` }}
        />
      ) : null}
    </Link>
  );
}

function Segment({ id, percent, top }: { id: CategoryId; percent: number; top: boolean }) {
  return (
    <span
      className={`block shrink-0 border-t-2 border-surface first:border-t-0 ${CATEGORY_FILL[id]} ${
        top ? "rounded-t-[3px]" : ""
      }`}
      style={{ height: `${String(percent)}%` }}
    />
  );
}
