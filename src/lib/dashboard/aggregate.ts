import {
  CATEGORY_IDS,
  todayIn,
  type CategoryId,
  type Member,
  type PricedExpense,
} from "@/lib/ledger";
import type { IsoDate } from "@/lib/money";
import {
  budgetFor,
  budgetState,
  splitBudget,
  type BudgetSettings,
  type BudgetSource,
  type BudgetState,
} from "./budget";
import { dayTiming, daysToShow, resolveTripRange, type DayTiming, type TripRange } from "./trip";

/** Money by category, with every category present (zero when unused). */
export type ByCategory = Record<CategoryId, number>;

function emptyByCategory(): ByCategory {
  return Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0])) as ByCategory;
}

/** One calendar day of spending, in SGD minor units, split every way the dashboard needs. */
export interface DayBucket {
  readonly date: IsoDate;
  readonly timing: DayTiming;
  /** Everything spent on the day (the sum of the members' shares). */
  readonly totalMinor: number;
  readonly byCategory: ByCategory;
  /** Each member's share of the day's expenses (not who paid). */
  readonly byMember: Readonly<Record<string, number>>;
  /** Each member's share, by category. */
  readonly byMemberCategory: Readonly<Record<string, ByCategory>>;
  readonly budgetMinor: number | null;
  readonly budgetSource: BudgetSource;
  /** Each member's slice of the day's budget (budget divided by members). Empty without a budget. */
  readonly memberBudgets: Readonly<Record<string, number>>;
  /** Every active expense on the day, newest first, including any that have no exchange rate yet. */
  readonly expenses: readonly PricedExpense[];
  /** Expenses on the day that have no exchange rate yet and so are left out of every figure. */
  readonly unpricedCount: number;
}

/** Whose spending to look at: the whole group (null) or one member's share. */
export type Scope = string | null;

export interface ScopedDay {
  readonly date: IsoDate;
  readonly timing: DayTiming;
  readonly spentMinor: number;
  readonly budgetMinor: number | null;
  readonly budgetSource: BudgetSource;
  readonly byCategory: ByCategory;
  readonly state: BudgetState;
}

/** A day seen through a scope: the group's spending against the group budget, or a member's share against their slice. */
export function scopedDay(day: DayBucket, scope: Scope): ScopedDay {
  const spentMinor = scope === null ? day.totalMinor : (day.byMember[scope] ?? 0);
  const budgetMinor =
    scope === null
      ? day.budgetMinor
      : day.budgetMinor === null
        ? null
        : (day.memberBudgets[scope] ?? 0);
  return {
    date: day.date,
    timing: day.timing,
    spentMinor,
    budgetMinor,
    budgetSource: day.budgetSource,
    byCategory:
      scope === null ? day.byCategory : (day.byMemberCategory[scope] ?? emptyByCategory()),
    state: budgetState(spentMinor, budgetMinor),
  };
}

export interface Rollup {
  readonly days: number;
  readonly spentMinor: number;
  /** Sum of the budgets of the days that have one. Null when no day has a budget. */
  readonly budgetMinor: number | null;
  /** Days that have a budget. */
  readonly budgetedDays: number;
  readonly daysOver: number;
  readonly state: BudgetState;
  /** Budget minus spending; negative when over. Null without a budget. */
  readonly remainingMinor: number | null;
  /** Spending per day, rounded to the nearest minor unit. Zero with no days. */
  readonly averageMinor: number;
}

/** Totals over a run of days. Only days that have a budget count towards the budget side. */
export function rollup(days: readonly ScopedDay[]): Rollup {
  let spentMinor = 0;
  let budgetMinor = 0;
  let budgetedDays = 0;
  let daysOver = 0;
  for (const day of days) {
    spentMinor += day.spentMinor;
    if (day.budgetMinor !== null) {
      budgetMinor += day.budgetMinor;
      budgetedDays += 1;
    }
    if (day.state === "over") daysOver += 1;
  }
  const budget = budgetedDays > 0 ? budgetMinor : null;
  // Compare like with like: only the spending on budgeted days is held against the budget.
  const budgetedSpent = days.reduce(
    (sum, d) => sum + (d.budgetMinor === null ? 0 : d.spentMinor),
    0,
  );
  return {
    days: days.length,
    spentMinor,
    budgetMinor: budget,
    budgetedDays,
    daysOver,
    state: budgetState(budgetedSpent, budget),
    remainingMinor: budget === null ? null : budget - budgetedSpent,
    averageMinor:
      days.length === 0 ? 0 : Math.floor((spentMinor * 2 + days.length) / (days.length * 2)),
  };
}

export interface DashboardModel {
  readonly timeZone: string;
  readonly today: IsoDate;
  readonly range: TripRange;
  readonly members: readonly Member[];
  /** Every day of the range, oldest first. */
  readonly days: readonly DayBucket[];
  /** Everything ever spent: equals the ledger's total spend exactly. */
  readonly totalMinor: number;
  readonly categoryTotals: ByCategory;
  readonly memberTotals: Readonly<Record<string, number>>;
  readonly unpricedCount: number;
  readonly hasBudget: boolean;
}

export interface DashboardInput {
  readonly members: readonly Member[];
  /** Active (not deleted) expenses, priced. */
  readonly priced: readonly PricedExpense[];
  readonly budgets: BudgetSettings;
  readonly tripStart: IsoDate | null;
  readonly tripEnd: IsoDate | null;
  readonly timeZone: string;
  readonly now: Date;
}

/**
 * Buckets the ledger by calendar day. A day is the date written on the expense, never shifted by
 * a time zone; the trip's time zone only decides which day is "today". Expenses without a rate
 * are counted aside, never guessed.
 */
export function buildDashboard(input: DashboardInput): DashboardModel {
  const today = todayIn(input.now, input.timeZone);
  const memberIds = input.members.map((member) => member.userId);

  const byDay = new Map<IsoDate, PricedExpense[]>();
  const unpricedByDay = new Map<IsoDate, number>();
  for (const item of input.priced) {
    const day = item.expense.spentOn;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(item);
    else byDay.set(day, [item]);
    if (!item.sgd) unpricedByDay.set(day, (unpricedByDay.get(day) ?? 0) + 1);
  }

  const activityDays = [...byDay.keys()];
  const range = resolveTripRange({
    tripStart: input.tripStart,
    tripEnd: input.tripEnd,
    activityDays,
    today,
  });

  const categoryTotals = emptyByCategory();
  const memberTotals: Record<string, number> = Object.fromEntries(memberIds.map((id) => [id, 0]));
  let totalMinor = 0;

  const days = daysToShow(range, activityDays).map((date): DayBucket => {
    const expenses = byDay.get(date) ?? [];
    const byCategory = emptyByCategory();
    const byMember: Record<string, number> = Object.fromEntries(memberIds.map((id) => [id, 0]));
    const byMemberCategory: Record<string, ByCategory> = Object.fromEntries(
      memberIds.map((id) => [id, emptyByCategory()]),
    );
    let dayTotal = 0;
    for (const { expense, sgd } of expenses) {
      if (!sgd) continue;
      dayTotal += sgd.totalMinor;
      byCategory[expense.category] += sgd.totalMinor;
      categoryTotals[expense.category] += sgd.totalMinor;
      for (const share of sgd.shares) {
        byMember[share.memberId] = (byMember[share.memberId] ?? 0) + share.minor;
        memberTotals[share.memberId] = (memberTotals[share.memberId] ?? 0) + share.minor;
        const own = byMemberCategory[share.memberId];
        if (own) own[expense.category] += share.minor;
      }
    }
    totalMinor += dayTotal;
    const budget = budgetFor(date, input.budgets);
    return {
      date,
      timing: dayTiming(date, today),
      totalMinor: dayTotal,
      byCategory,
      byMember,
      byMemberCategory,
      budgetMinor: budget.amountMinor,
      budgetSource: budget.source,
      memberBudgets: budget.amountMinor === null ? {} : splitBudget(budget.amountMinor, memberIds),
      expenses,
      unpricedCount: unpricedByDay.get(date) ?? 0,
    };
  });

  return {
    timeZone: input.timeZone,
    today,
    range,
    members: input.members,
    days,
    totalMinor,
    categoryTotals,
    memberTotals,
    unpricedCount: [...unpricedByDay.values()].reduce((a, b) => a + b, 0),
    hasBudget: input.budgets.defaultMinor !== null || input.budgets.overrides.size > 0,
  };
}

/** The days up to and including today: what "so far" means. After the trip it is every day. */
export function daysSoFar(days: readonly ScopedDay[]): ScopedDay[] {
  return days.filter((day) => day.timing !== "future");
}
