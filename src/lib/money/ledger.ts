import { type CurrencyCode } from "./currency";
import { assertIsoDate, type IsoDate } from "./dates";
import { allocateProportional, type Allocation, type MemberId } from "./allocate";
import {
  toReportingCurrency,
  type BilledAmount,
  type ConversionSource,
  type RateBook,
} from "./convert";
import { MoneyError } from "./errors";
import { assertNonNegativeMinor, assertPositiveMinor, sum, type Minor } from "./integer";
import type { Rate } from "./rate";

/**
 * The ledger maths. Nothing here is stored: balances are always derived from
 * the expenses and settlements that are still active (callers pass only rows
 * that are not soft-deleted). Entries inside an expense are expected in the
 * group's fixed member order; `computeBalances` re-sorts them by `members` so
 * rounding ties are deterministic.
 */

export interface LedgerExpense {
  readonly id: string;
  readonly date: IsoDate;
  /** The amount in the currency shown on the receipt. */
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
  readonly billed?: BilledAmount | undefined;
  readonly rate?: Rate | undefined;
  /** Who paid how much, in the native currency. Sums to `amountMinor`. */
  readonly payers: readonly Allocation[];
  /** Who owes how much, in the native currency. Sums to `amountMinor`. */
  readonly shares: readonly Allocation[];
}

/** One member handing money to another. Modelled as an expense paid by `from` and owed by `to`. */
export interface LedgerSettlement {
  readonly id: string;
  readonly date: IsoDate;
  readonly fromMemberId: MemberId;
  readonly toMemberId: MemberId;
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
  readonly billed?: BilledAmount | undefined;
  readonly rate?: Rate | undefined;
}

export interface MemberBalance {
  readonly memberId: MemberId;
  /** Total paid towards expenses. */
  readonly paidMinor: Minor;
  /** Total share of expenses. */
  readonly owedMinor: Minor;
  /** Settlements sent minus settlements received. */
  readonly settledMinor: Minor;
  /** paid - owed + settled. Positive: the group owes them. Negative: they owe the group. */
  readonly balanceMinor: Minor;
}

export interface ExpenseInReportingCurrency {
  readonly totalMinor: Minor;
  readonly source: ConversionSource;
  readonly rate?: Rate | undefined;
  readonly payers: readonly Allocation[];
  readonly shares: readonly Allocation[];
}

function checkSide(
  side: readonly Allocation[],
  total: Minor,
  label: "payers" | "shares",
  expenseId: string,
): void {
  if (side.length === 0) {
    throw new MoneyError("invalid_expense", `Expense ${expenseId} has no ${label}`);
  }
  const seen = new Set<MemberId>();
  for (const entry of side) {
    assertNonNegativeMinor(entry.minor, `${label} amount`);
    if (seen.has(entry.memberId)) {
      throw new MoneyError(
        "duplicate_member",
        `Expense ${expenseId} lists ${entry.memberId} twice in ${label}`,
      );
    }
    seen.add(entry.memberId);
  }
  const entered = sum(side.map((entry) => entry.minor));
  if (entered !== total) {
    throw new MoneyError(
      label === "payers" ? "payer_total_mismatch" : "split_total_mismatch",
      `Expense ${expenseId} ${label} total ${entered}, expected ${total}`,
    );
  }
}

/** Throws a MoneyError unless the expense is internally consistent. */
export function assertExpenseInvariants(expense: LedgerExpense): void {
  assertIsoDate(expense.date, "expense date");
  assertPositiveMinor(expense.amountMinor, "expense amount");
  if (expense.billed) assertPositiveMinor(expense.billed.amountMinor, "billed amount");
  checkSide(expense.payers, expense.amountMinor, "payers", expense.id);
  checkSide(expense.shares, expense.amountMinor, "shares", expense.id);
}

function inMemberOrder(entries: readonly Allocation[], order: readonly MemberId[]): Allocation[] {
  const position = new Map(order.map((id, index) => [id, index] as const));
  for (const entry of entries) {
    if (!position.has(entry.memberId)) {
      throw new MoneyError("unknown_member", `Member is not in the group: ${entry.memberId}`);
    }
  }
  return [...entries].sort(
    (a, b) => (position.get(a.memberId) ?? 0) - (position.get(b.memberId) ?? 0),
  );
}

/**
 * Prices one expense in SGD. The SGD total is decided once (billed figure or
 * converted), then spread over the native payer amounts and shares with the
 * largest-remainder method so both sides still add up to it exactly.
 */
export function expenseInReportingCurrency(
  expense: LedgerExpense,
  book: RateBook,
  memberOrder: readonly MemberId[],
): ExpenseInReportingCurrency {
  assertExpenseInvariants(expense);
  const conversion = toReportingCurrency(expense, book);

  const spread = (side: readonly Allocation[]): Allocation[] => {
    const ordered = inMemberOrder(side, memberOrder);
    const minors = allocateProportional(
      conversion.sgdMinor,
      ordered.map((entry) => entry.minor),
    );
    return ordered.map((entry, i) => ({ memberId: entry.memberId, minor: minors[i] ?? 0 }));
  };

  return {
    totalMinor: conversion.sgdMinor,
    source: conversion.source,
    rate: conversion.rate,
    payers: spread(expense.payers),
    shares: spread(expense.shares),
  };
}

export interface BalanceInput {
  /** The group's members in their fixed order; also the rounding tie order. */
  readonly members: readonly MemberId[];
  readonly expenses: readonly LedgerExpense[];
  readonly settlements?: readonly LedgerSettlement[];
  readonly rates: RateBook;
}

export interface Balances {
  /** Every member, in `members` order, in SGD. Sums to zero. */
  readonly reporting: readonly MemberBalance[];
  /** Per native currency, every member, in `members` order. Each currency sums to zero. */
  readonly byCurrency: Readonly<Partial<Record<CurrencyCode, readonly MemberBalance[]>>>;
}

interface Tally {
  paid: number;
  owed: number;
  sent: number;
  received: number;
}

class Tallies {
  private readonly tallies = new Map<MemberId, Tally>();

  constructor(private readonly members: readonly MemberId[]) {
    for (const member of members) {
      this.tallies.set(member, { paid: 0, owed: 0, sent: 0, received: 0 });
    }
  }

  add(memberId: MemberId, field: keyof Tally, minor: Minor): void {
    const tally = this.tallies.get(memberId);
    if (!tally) throw new MoneyError("unknown_member", `Member is not in the group: ${memberId}`);
    tally[field] += minor;
  }

  result(): MemberBalance[] {
    return this.members.map((memberId) => {
      const tally = this.tallies.get(memberId) ?? { paid: 0, owed: 0, sent: 0, received: 0 };
      const settledMinor = tally.sent - tally.received;
      return {
        memberId,
        paidMinor: tally.paid,
        owedMinor: tally.owed,
        settledMinor,
        balanceMinor: tally.paid - tally.owed + settledMinor,
      };
    });
  }
}

export function computeBalances(input: BalanceInput): Balances {
  const { members, rates } = input;
  if (new Set(members).size !== members.length) {
    throw new MoneyError("duplicate_member", "The member list contains duplicates");
  }

  const reporting = new Tallies(members);
  const native = new Map<CurrencyCode, Tallies>();
  const nativeFor = (currency: CurrencyCode): Tallies => {
    let tallies = native.get(currency);
    if (!tallies) {
      tallies = new Tallies(members);
      native.set(currency, tallies);
    }
    return tallies;
  };

  for (const expense of input.expenses) {
    const priced = expenseInReportingCurrency(expense, rates, members);
    const nativeTallies = nativeFor(expense.currency);
    for (const payer of priced.payers) reporting.add(payer.memberId, "paid", payer.minor);
    for (const share of priced.shares) reporting.add(share.memberId, "owed", share.minor);
    for (const payer of expense.payers) nativeTallies.add(payer.memberId, "paid", payer.minor);
    for (const share of expense.shares) nativeTallies.add(share.memberId, "owed", share.minor);
  }

  for (const settlement of input.settlements ?? []) {
    assertPositiveMinor(settlement.amountMinor, "settlement amount");
    if (settlement.fromMemberId === settlement.toMemberId) {
      throw new MoneyError(
        "invalid_expense",
        `Settlement ${settlement.id} pays a member to themselves`,
      );
    }
    const conversion = toReportingCurrency(settlement, rates);
    reporting.add(settlement.fromMemberId, "sent", conversion.sgdMinor);
    reporting.add(settlement.toMemberId, "received", conversion.sgdMinor);
    const nativeTallies = nativeFor(settlement.currency);
    nativeTallies.add(settlement.fromMemberId, "sent", settlement.amountMinor);
    nativeTallies.add(settlement.toMemberId, "received", settlement.amountMinor);
  }

  const byCurrency: Partial<Record<CurrencyCode, readonly MemberBalance[]>> = {};
  for (const [currency, tallies] of native) byCurrency[currency] = tallies.result();

  return { reporting: reporting.result(), byCurrency };
}
