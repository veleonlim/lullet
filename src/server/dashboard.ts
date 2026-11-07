import { buildDashboard, type DashboardModel } from "@/lib/dashboard";
import { priceExpenses } from "@/lib/ledger";
import type { DashboardData, LedgerStore } from "./ledger";

/**
 * The ledger bucketed by day for the dashboard pages: expenses priced in SGD through the usual
 * rate precedence, then summed per day, member and category. "Today" follows the trip's time zone.
 */
export async function loadDashboardModel(
  store: LedgerStore,
  now: Date = new Date(),
): Promise<{ model: DashboardModel; data: DashboardData }> {
  const data = await store.loadDashboard();
  const order = data.members.map((member) => member.userId);
  const model = buildDashboard({
    members: data.members,
    priced: priceExpenses(data.expenses, data.book, order),
    budgets: data.budgets,
    tripStart: data.tripStart,
    tripEnd: data.tripEnd,
    timeZone: data.timeZone,
    now,
  });
  return { model, data };
}
