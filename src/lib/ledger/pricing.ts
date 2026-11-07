import {
  assertCurrencyCode,
  computeBalances,
  expenseInReportingCurrency,
  MoneyError,
  parseRate,
  suggestTransfers,
  toReportingCurrency,
  type Balances,
  type Conversion,
  type ConvertibleAmount,
  type CurrencyCode,
  type ExpenseInReportingCurrency,
  type LedgerExpense,
  type LedgerSettlement,
  type RateBook,
  type Transfer,
} from "@/lib/money";
import type { PricedSource, StoredExpense, StoredSettlement } from "./types";

/** Turns the stored billed amount, rate and priced rate columns into the money library's shapes. */
function convertible(row: {
  spentOn?: string;
  settledOn?: string;
  amountMinor: number;
  currency: string;
  billedAmountMinor: number | null;
  billedCurrency: string | null;
  rate: string | null;
  rateCurrency: string | null;
  pricedRate: string | null;
  pricedRateCurrency: string | null;
  pricedSource: PricedSource | null;
}): ConvertibleAmount {
  return {
    date: row.spentOn ?? row.settledOn ?? "",
    amountMinor: row.amountMinor,
    currency: assertCurrencyCode(row.currency),
    billed:
      row.billedAmountMinor !== null && row.billedCurrency !== null
        ? { amountMinor: row.billedAmountMinor, currency: assertCurrencyCode(row.billedCurrency) }
        : undefined,
    rate:
      row.rate !== null && row.rateCurrency !== null
        ? { currency: assertCurrencyCode(row.rateCurrency), rate: parseRate(row.rate) }
        : undefined,
    priced:
      row.pricedRate !== null && row.pricedRateCurrency !== null && row.pricedSource !== null
        ? {
            currency: assertCurrencyCode(row.pricedRateCurrency),
            rate: parseRate(row.pricedRate),
            source: row.pricedSource,
          }
        : undefined,
  };
}

export function toLedgerExpense(expense: StoredExpense): LedgerExpense {
  return {
    id: expense.id,
    ...convertible(expense),
    payers: expense.payers.map((payer) => ({ memberId: payer.userId, minor: payer.amountMinor })),
    shares: expense.shares.map((share) => ({ memberId: share.userId, minor: share.amountMinor })),
  };
}

export function toLedgerSettlement(settlement: StoredSettlement): LedgerSettlement {
  return {
    id: settlement.id,
    ...convertible(settlement),
    fromMemberId: settlement.fromUserId,
    toMemberId: settlement.toUserId,
  };
}

/**
 * Which currency's stored market rate this amount needs, if any. It runs the money
 * library's own precedence with a probe in place of the market rates, so the answer
 * can never drift from how the amount is really converted.
 */
export function marketRateNeeded(
  amount: ConvertibleAmount,
  dayOverrides: Pick<RateBook, "dayOverride">,
): CurrencyCode | null {
  let needed: CurrencyCode | null = null;
  const probe: RateBook = {
    dayOverride: (date, currency) => dayOverrides.dayOverride(date, currency),
    market: (_date, currency) => {
      needed = currency;
      return parseRate("1");
    },
  };
  toReportingCurrency(amount, probe);
  return needed;
}

export function expenseMarketRateNeeded(
  expense: Pick<
    StoredExpense,
    | "spentOn"
    | "amountMinor"
    | "currency"
    | "billedAmountMinor"
    | "billedCurrency"
    | "rate"
    | "rateCurrency"
    | "pricedRate"
    | "pricedRateCurrency"
    | "pricedSource"
  >,
  dayOverrides: Pick<RateBook, "dayOverride">,
): CurrencyCode | null {
  return marketRateNeeded(convertible(expense), dayOverrides);
}

export interface PricedExpense {
  readonly expense: StoredExpense;
  /** The SGD view of the expense, or undefined when no rate is known (see `missingRate`). */
  readonly sgd: ExpenseInReportingCurrency | undefined;
  /** Set when the SGD figure cannot be worked out. */
  readonly problem: string | undefined;
}

/** Prices each expense in SGD. A missing rate never throws: the expense is returned unpriced. */
export function priceExpenses(
  expenses: readonly StoredExpense[],
  book: RateBook,
  memberOrder: readonly string[],
): PricedExpense[] {
  return expenses.map((expense) => {
    try {
      return {
        expense,
        sgd: expenseInReportingCurrency(toLedgerExpense(expense), book, memberOrder),
        problem: undefined,
      };
    } catch (error) {
      if (error instanceof MoneyError && error.code === "missing_rate") {
        return { expense, sgd: undefined, problem: error.message };
      }
      throw error;
    }
  });
}

/** A settlement's SGD figure, or undefined when no exchange rate is known for it. */
export function priceSettlement(
  settlement: StoredSettlement,
  book: RateBook,
): Conversion | undefined {
  try {
    return toReportingCurrency(toLedgerSettlement(settlement), book);
  } catch (error) {
    if (error instanceof MoneyError && error.code === "missing_rate") return undefined;
    throw error;
  }
}

export interface LedgerSummary {
  readonly balances: Balances;
  /** The fewest payments that settle everyone up, in SGD. */
  readonly transfers: readonly Transfer[];
  /** Records left out of the balances because no exchange rate is known for them. */
  readonly unpricedExpenseIds: readonly string[];
  readonly unpricedSettlementIds: readonly string[];
  /** Sum of all priced expenses in SGD. */
  readonly totalSpendMinor: number;
}

/** Everything the balances page shows, derived from the active (not deleted) rows. */
export function summariseLedger(input: {
  readonly memberOrder: readonly string[];
  readonly expenses: readonly StoredExpense[];
  readonly settlements: readonly StoredSettlement[];
  readonly book: RateBook;
}): LedgerSummary {
  const pricedExpenses = priceExpenses(input.expenses, input.book, input.memberOrder);
  const pricedSettlements = input.settlements.map((settlement) => ({
    settlement,
    ok: priceSettlement(settlement, input.book) !== undefined,
  }));

  const balances = computeBalances({
    members: input.memberOrder,
    expenses: pricedExpenses.filter((p) => p.sgd).map((p) => toLedgerExpense(p.expense)),
    settlements: pricedSettlements.filter((p) => p.ok).map((p) => toLedgerSettlement(p.settlement)),
    rates: input.book,
  });
  const transfers = suggestTransfers(
    balances.reporting.map((entry) => ({
      memberId: entry.memberId,
      balanceMinor: entry.balanceMinor,
    })),
  );
  return {
    balances,
    transfers,
    unpricedExpenseIds: pricedExpenses.filter((p) => !p.sgd).map((p) => p.expense.id),
    unpricedSettlementIds: pricedSettlements.filter((p) => !p.ok).map((p) => p.settlement.id),
    totalSpendMinor: pricedExpenses.reduce((total, p) => total + (p.sgd?.totalMinor ?? 0), 0),
  };
}
