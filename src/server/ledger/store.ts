import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import type { Session } from "@/lib/auth/session";
import {
  diffPricing,
  usesDayRate,
  type BudgetSettings,
  type DailyRateInput,
  type RepriceChange,
  type BudgetInput,
  type TripInput,
} from "@/lib/dashboard";
import { FxRateError, type FxRateClient } from "@/lib/fx";
import {
  expenseMarketRateNeeded,
  marketRateNeeded,
  snapshotExpense,
  snapshotSettlement,
  type AuditAction,
  type ExpenseInput,
  type Member,
  type SettlementInput,
  type StoredExpense,
  type StoredSettlement,
} from "@/lib/ledger";
import {
  createRateBook,
  formatRate,
  rateEquals,
  parseRate,
  rateEntryFromRow,
  REPORTING_CURRENCY,
  type CurrencyCode,
  type IsoDate,
  type RateBook,
} from "@/lib/money";
import {
  ConflictError,
  InvalidReferenceError,
  NotAMemberError,
  NotFoundError,
  RateUnavailableError,
} from "./errors";

/**
 * The single data-access layer for the ledger. Every read and write goes through a
 * store created from the caller's session, and every query below filters by
 * `session.groupId` - including the child tables and the audit log - so one group can
 * never see or change another group's records. Nothing else in the app imports the
 * database schema for ledger data (ESLint enforces that).
 *
 * The only table that is not group scoped is `fx_rates`: market exchange rates are the
 * same for everyone and hold no group data.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

export interface AuditEntry {
  readonly id: number;
  readonly action: string;
  readonly actorUserId: string | null;
  readonly createdAt: Date;
  readonly before: unknown;
  readonly after: unknown;
}

export interface LedgerData {
  readonly members: readonly Member[];
  /** Active (not deleted) expenses, newest first. */
  readonly expenses: readonly StoredExpense[];
  /** Active settlements, newest first. */
  readonly settlements: readonly StoredSettlement[];
  /** Exchange rates for every day and currency the records above need. */
  readonly book: RateBook;
}

export interface TripSettings {
  readonly tripStart: IsoDate | null;
  readonly tripEnd: IsoDate | null;
  readonly timeZone: string;
}

/** What the dashboard, budget and rates pages need, in one consistent read. */
export interface DashboardData extends TripSettings {
  readonly members: readonly Member[];
  /** Active (not deleted) expenses, newest first. */
  readonly expenses: readonly StoredExpense[];
  readonly book: RateBook;
  readonly budgets: BudgetSettings;
}

export interface DayRateRow {
  readonly day: IsoDate;
  readonly currency: CurrencyCode;
  /** SGD per 1 unit of `currency`, as exact decimal text. */
  readonly rate: string;
}

export interface RepriceResult {
  /** Expenses on the day whose SGD figure the day's rate can decide. */
  readonly affected: number;
  /** The expenses whose SGD figure actually changed. */
  readonly changes: readonly RepriceChange[];
}

export interface LedgerStore {
  readonly session: Session;
  members(): Promise<Member[]>;
  /** Everything the pages need to price the ledger in SGD, in one consistent read. */
  loadLedger(): Promise<LedgerData>;
  /**
   * Exchange rates for records the caller already holds, e.g. a deleted expense that
   * `loadLedger` leaves out. Day overrides come from the caller's group only.
   */
  rateBookFor(
    records: readonly { spentOn: string; currency: string; billedCurrency: string | null }[],
  ): Promise<RateBook>;
  listExpenses(options?: { deleted?: boolean }): Promise<StoredExpense[]>;
  /** One expense including a deleted one; null when it is not in the caller's group. */
  getExpense(id: string): Promise<StoredExpense | null>;
  /** The expenses a screenshot import created, deleted ones included. */
  listImportExpenses(importId: string): Promise<StoredExpense[]>;
  createExpense(input: ExpenseInput): Promise<StoredExpense>;
  /** `expectedUpdatedAt` guards against overwriting someone else's edit. */
  updateExpense(id: string, input: ExpenseInput, expectedUpdatedAt: Date): Promise<StoredExpense>;
  deleteExpense(id: string): Promise<StoredExpense>;
  restoreExpense(id: string): Promise<StoredExpense>;
  /** Who changed what, oldest first. */
  expenseHistory(id: string): Promise<AuditEntry[]>;
  listSettlements(options?: { deleted?: boolean }): Promise<StoredSettlement[]>;
  /** Members, active expenses with their exchange rates, the trip's dates and every budget. */
  loadDashboard(): Promise<DashboardData>;
  updateTrip(input: TripInput): Promise<TripSettings>;
  /** Sets the default daily budget (`day` null) or the budget for one day. Audit-logged. */
  setBudget(input: BudgetInput): Promise<void>;
  /** Removes the default (`day` null) or one day's override. Audit-logged; a no-op when none is set. */
  clearBudget(day: IsoDate | null): Promise<void>;
  /** The group's default rates for one currency, every day that has one. */
  listDayRates(currency: CurrencyCode): Promise<DayRateRow[]>;
  /** Stored market rates for one currency between two days (inclusive). */
  listMarketRates(currency: CurrencyCode, from: IsoDate, to: IsoDate): Promise<DayRateRow[]>;
  /** Sets the day's default rate; its expenses are re-priced at once, and every change is audit-logged. */
  setDailyRate(input: DailyRateInput): Promise<RepriceResult>;
  /** Removes the day's default rate, so the market rate applies again. Refused if that would leave an expense unpriced. */
  clearDailyRate(input: { day: IsoDate; currency: CurrencyCode }): Promise<RepriceResult>;
  /** Re-checks a day: fetches a missing market rate, re-prices through the precedence and audit-logs the result. */
  repriceDay(input: { day: IsoDate; currency: CurrencyCode }): Promise<RepriceResult>;
  createSettlement(input: SettlementInput): Promise<StoredSettlement>;
  deleteSettlement(id: string): Promise<StoredSettlement>;
  restoreSettlement(id: string): Promise<StoredSettlement>;
}

export interface StoreOptions {
  readonly db: Database;
  readonly session: Session;
  /** Fetches a market rate the first time a day needs one. */
  readonly fx: FxRateClient;
  readonly now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids arrive from URLs and form posts; anything that is not a UUID cannot name a record. */
function assertId(id: string, what: string): void {
  if (!UUID.test(id)) throw new NotFoundError(what);
}

/**
 * What the screenshot import needs from the ledger to add and reverse a whole batch of expenses
 * in one transaction. It is built from the same session and group scoping as the store, so
 * nothing here can reach another group's records.
 */
export interface LedgerKit {
  readonly store: LedgerStore;
  readonly session: Session;
  readonly now: () => Date;
  /** Checks the people named and makes sure the day's market rate is stored. A missing rate is not an error here. */
  prepareExpense(input: ExpenseInput): Promise<{ priced: boolean }>;
  insertExpense(
    tx: Tx,
    input: ExpenseInput,
    link: { importId: string; importRowId: string },
  ): Promise<StoredExpense>;
  deleteExpenseIn(tx: Tx, id: string): Promise<StoredExpense>;
  audit(
    tx: Tx,
    entry: {
      action: AuditAction;
      entityType: "expense" | "settlement" | "import";
      entityId: string;
      before: unknown;
      after: unknown;
    },
  ): Promise<void>;
}

export type { Tx };

export function createLedgerStore(options: StoreOptions): LedgerStore {
  return createLedgerKit(options).store;
}

export function createLedgerKit(options: StoreOptions): LedgerKit {
  const { db, session, fx } = options;
  const now = options.now ?? (() => new Date());
  const groupId = session.groupId;

  let membersPromise: Promise<Member[]> | undefined;

  /** Loads the group's members, and proves the caller is one of them. Memoised per store. */
  function members(): Promise<Member[]> {
    membersPromise ??= (async () => {
      const rows = await db
        .select({
          userId: s.memberships.userId,
          displayName: s.users.displayName,
          position: s.memberships.position,
        })
        .from(s.memberships)
        .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
        .where(eq(s.memberships.groupId, groupId))
        .orderBy(asc(s.memberships.position));
      if (!rows.some((row) => row.userId === session.userId)) throw new NotAMemberError();
      return rows;
    })();
    return membersPromise;
  }

  async function memberIds(): Promise<Set<string>> {
    return new Set((await members()).map((member) => member.userId));
  }

  async function assertMembers(ids: readonly string[]): Promise<void> {
    const known = await memberIds();
    if (ids.some((id) => !known.has(id))) throw new InvalidReferenceError();
  }

  // ---- reading -----------------------------------------------------------------------

  async function readExpenses(
    executor: Executor,
    where: SQL | undefined,
  ): Promise<StoredExpense[]> {
    const rows = await executor
      .select()
      .from(s.expenses)
      .where(and(eq(s.expenses.groupId, groupId), where))
      .orderBy(desc(s.expenses.spentOn), desc(s.expenses.createdAt), desc(s.expenses.id));
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const payers = await executor
      .select()
      .from(s.expensePayers)
      .where(and(eq(s.expensePayers.groupId, groupId), inArray(s.expensePayers.expenseId, ids)));
    const shares = await executor
      .select()
      .from(s.expenseShares)
      .where(and(eq(s.expenseShares.groupId, groupId), inArray(s.expenseShares.expenseId, ids)));
    const order = new Map((await members()).map((m) => [m.userId, m.position] as const));
    const byPosition = <T extends { userId: string }>(a: T, b: T) =>
      (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0);

    return rows.map((row) => ({
      id: row.id,
      importId: row.importId,
      description: row.description,
      category: row.category,
      spentOn: row.spentOn,
      amountMinor: row.amountMinor,
      currency: row.currency,
      billedAmountMinor: row.billedAmountMinor,
      billedCurrency: row.billedCurrency,
      rate: row.rate,
      rateCurrency: row.rateCurrency,
      splitMethod: row.splitMethod,
      payers: payers
        .filter((payer) => payer.expenseId === row.id)
        .map((payer) => ({ userId: payer.userId, amountMinor: payer.amountMinor }))
        .sort(byPosition),
      shares: shares
        .filter((share) => share.expenseId === row.id)
        .map((share) => ({
          userId: share.userId,
          amountMinor: share.amountMinor,
          weight: share.weight,
        }))
        .sort(byPosition),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
    }));
  }

  async function readExpense(executor: Executor, id: string): Promise<StoredExpense | null> {
    if (!UUID.test(id)) return null;
    const [expense] = await readExpenses(executor, eq(s.expenses.id, id));
    return expense ?? null;
  }

  async function readSettlements(
    executor: Executor,
    where: SQL | undefined,
  ): Promise<StoredSettlement[]> {
    const rows = await executor
      .select()
      .from(s.settlements)
      .where(and(eq(s.settlements.groupId, groupId), where))
      .orderBy(
        desc(s.settlements.settledOn),
        desc(s.settlements.createdAt),
        desc(s.settlements.id),
      );
    return rows.map((row) => ({
      id: row.id,
      fromUserId: row.fromUserId,
      toUserId: row.toUserId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      billedAmountMinor: row.billedAmountMinor,
      billedCurrency: row.billedCurrency,
      rate: row.rate,
      rateCurrency: row.rateCurrency,
      settledOn: row.settledOn,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
    }));
  }

  async function readSettlement(executor: Executor, id: string): Promise<StoredSettlement | null> {
    const [settlement] = await readSettlements(executor, eq(s.settlements.id, id));
    return settlement ?? null;
  }

  /** Stored market rates and this group's day overrides for the days and currencies in use. */
  async function loadRateBook(
    items: readonly { date: string; currencies: readonly (string | null)[] }[],
    executor: Executor = db,
  ): Promise<RateBook> {
    const currencies = [
      ...new Set(items.flatMap((item) => item.currencies).filter((c): c is string => c !== null)),
    ].filter((currency) => currency !== REPORTING_CURRENCY);
    const dates = items.map((item) => item.date).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (currencies.length === 0 || first === undefined || last === undefined) {
      return createRateBook({});
    }
    const market = await executor
      .select()
      .from(s.fxRates)
      .where(
        and(
          eq(s.fxRates.quote, REPORTING_CURRENCY),
          inArray(s.fxRates.base, currencies),
          gte(s.fxRates.rateDate, first),
          lte(s.fxRates.rateDate, last),
        ),
      );
    const overrides = await executor
      .select()
      .from(s.dailyRates)
      .where(
        and(
          eq(s.dailyRates.groupId, groupId),
          inArray(s.dailyRates.base, currencies),
          gte(s.dailyRates.rateDate, first),
          lte(s.dailyRates.rateDate, last),
        ),
      );
    return createRateBook({
      market: market.map(rateEntryFromRow),
      overrides: overrides.map(rateEntryFromRow),
    });
  }

  /** Makes sure the market rate an amount needs is stored, fetching it the first time. */
  async function ensureMarketRate(amount: {
    date: string;
    needed: (overrides: Pick<RateBook, "dayOverride">) => CurrencyCode | null;
  }): Promise<void> {
    const overrides = await db
      .select()
      .from(s.dailyRates)
      .where(and(eq(s.dailyRates.groupId, groupId), eq(s.dailyRates.rateDate, amount.date)));
    const currency = amount.needed(createRateBook({ overrides: overrides.map(rateEntryFromRow) }));
    if (currency === null) return;
    await storeMarketRate(amount.date, currency);
  }

  /** Stores the day's market rate the first time it is needed; stored rates never change. */
  async function storeMarketRate(date: string, currency: CurrencyCode): Promise<void> {
    const [stored] = await db
      .select({ rate: s.fxRates.rate })
      .from(s.fxRates)
      .where(
        and(
          eq(s.fxRates.rateDate, date),
          eq(s.fxRates.base, currency),
          eq(s.fxRates.quote, REPORTING_CURRENCY),
        ),
      )
      .limit(1);
    if (stored) return;

    let quote;
    try {
      quote = await fx.getRate(date, currency, REPORTING_CURRENCY);
    } catch (error) {
      if (error instanceof FxRateError) throw new RateUnavailableError(currency, date);
      throw error;
    }
    await db
      .insert(s.fxRates)
      .values({
        rateDate: date,
        base: currency,
        quote: REPORTING_CURRENCY,
        rate: formatRate(quote.rate),
        sourceDate: quote.rateDate,
        provider: quote.provider,
      })
      .onConflictDoNothing();
  }

  async function audit(
    tx: Tx,
    entry: {
      action: AuditAction;
      entityType: "expense" | "settlement" | "import" | "budget" | "daily_rate" | "group";
      entityId: string | null;
      before: unknown;
      after: unknown;
    },
  ): Promise<void> {
    await tx.insert(s.auditLog).values({
      groupId,
      actorUserId: session.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
    });
  }

  function expenseColumns(input: ExpenseInput) {
    return {
      description: input.description,
      category: input.category,
      spentOn: input.spentOn,
      amountMinor: input.amountMinor,
      currency: input.currency,
      billedAmountMinor: input.billed?.amountMinor ?? null,
      billedCurrency: input.billed?.currency ?? null,
      rate: input.rate ? formatRate(input.rate.rate) : null,
      rateCurrency: input.rate?.currency ?? null,
      splitMethod: input.splitMethod,
    };
  }

  async function writePayersAndShares(tx: Tx, expenseId: string, input: ExpenseInput) {
    await tx.insert(s.expensePayers).values(
      input.payers.map((payer) => ({
        expenseId,
        groupId,
        userId: payer.userId,
        amountMinor: payer.amountMinor,
      })),
    );
    await tx.insert(s.expenseShares).values(
      input.shares.map((share) => ({
        expenseId,
        groupId,
        userId: share.userId,
        amountMinor: share.amountMinor,
        weight: share.weight,
      })),
    );
  }

  async function expenseInput(input: ExpenseInput): Promise<void> {
    await assertMembers([
      ...input.payers.map((p) => p.userId),
      ...input.shares.map((p) => p.userId),
    ]);
    await ensureMarketRate({
      date: input.spentOn,
      needed: (overrides) =>
        marketRateNeeded(
          {
            date: input.spentOn,
            amountMinor: input.amountMinor,
            currency: input.currency,
            billed: input.billed ?? undefined,
            rate: input.rate ?? undefined,
          },
          overrides,
        ),
    });
  }

  /** Inserts an expense with its payers and shares and an audit row; the caller supplies the transaction. */
  async function insertExpense(
    tx: Tx,
    input: ExpenseInput,
    link?: { importId: string; importRowId: string },
  ): Promise<StoredExpense> {
    const at = now();
    const [row] = await tx
      .insert(s.expenses)
      .values({
        ...expenseColumns(input),
        ...(link ? { importId: link.importId, importRowId: link.importRowId } : {}),
        groupId,
        createdBy: session.userId,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: s.expenses.id });
    if (!row) throw new Error("expense insert returned nothing");
    await writePayersAndShares(tx, row.id, input);
    const created = await readExpense(tx, row.id);
    if (!created) throw new Error("expense vanished after insert");
    await audit(tx, {
      action: "expense.create",
      entityType: "expense",
      entityId: row.id,
      before: null,
      after: snapshotExpense(created),
    });
    return created;
  }

  /** Soft deletes or restores an expense inside the caller's transaction. */
  async function setExpenseDeletedIn(tx: Tx, id: string, deleted: boolean): Promise<StoredExpense> {
    const [row] = await tx
      .select({ deletedAt: s.expenses.deletedAt })
      .from(s.expenses)
      .where(and(eq(s.expenses.groupId, groupId), eq(s.expenses.id, id)))
      .for("update");
    if (!row) throw new NotFoundError("Expense");
    const current = await readExpense(tx, id);
    if (!current) throw new NotFoundError("Expense");
    if ((row.deletedAt !== null) === deleted) return current; // already in that state
    const at = now();
    await tx
      .update(s.expenses)
      .set(
        deleted
          ? { deletedAt: at, deletedBy: session.userId, updatedAt: at }
          : { deletedAt: null, deletedBy: null, updatedAt: at },
      )
      .where(and(eq(s.expenses.groupId, groupId), eq(s.expenses.id, id)));
    const after = await readExpense(tx, id);
    if (!after) throw new NotFoundError("Expense");
    const snapshot = snapshotExpense(current);
    await audit(tx, {
      action: deleted ? "expense.delete" : "expense.restore",
      entityType: "expense",
      entityId: id,
      before: deleted ? snapshot : null,
      after: deleted ? null : snapshot,
    });
    return after;
  }

  async function setExpenseDeleted(id: string, deleted: boolean): Promise<StoredExpense> {
    await members();
    assertId(id, "Expense");
    return db.transaction((tx) => setExpenseDeletedIn(tx, id, deleted));
  }

  async function setSettlementDeleted(id: string, deleted: boolean): Promise<StoredSettlement> {
    await members();
    assertId(id, "Settlement");
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ deletedAt: s.settlements.deletedAt })
        .from(s.settlements)
        .where(and(eq(s.settlements.groupId, groupId), eq(s.settlements.id, id)))
        .for("update");
      if (!row) throw new NotFoundError("Settlement");
      const current = await readSettlement(tx, id);
      if (!current) throw new NotFoundError("Settlement");
      if ((row.deletedAt !== null) === deleted) return current;
      await tx
        .update(s.settlements)
        .set(
          deleted
            ? { deletedAt: now(), deletedBy: session.userId }
            : { deletedAt: null, deletedBy: null },
        )
        .where(and(eq(s.settlements.groupId, groupId), eq(s.settlements.id, id)));
      const after = await readSettlement(tx, id);
      if (!after) throw new NotFoundError("Settlement");
      const snapshot = snapshotSettlement(current);
      await audit(tx, {
        action: deleted ? "settlement.delete" : "settlement.restore",
        entityType: "settlement",
        entityId: id,
        before: deleted ? snapshot : null,
        after: deleted ? null : snapshot,
      });
      return after;
    });
  }

  // ---- dashboard, budgets and daily rates ---------------------------------------------

  async function readBudgets(): Promise<BudgetSettings> {
    const rows = await db.select().from(s.budgets).where(eq(s.budgets.groupId, groupId));
    return {
      defaultMinor: rows.find((row) => row.day === null)?.amountMinor ?? null,
      overrides: new Map(
        rows.flatMap((row) => (row.day === null ? [] : [[row.day, row.amountMinor] as const])),
      ),
    };
  }

  async function readTrip(executor: Executor): Promise<TripSettings> {
    const [row] = await executor
      .select({
        tripStart: s.groups.tripStart,
        tripEnd: s.groups.tripEnd,
        timeZone: s.groups.timeZone,
      })
      .from(s.groups)
      .where(eq(s.groups.id, groupId));
    if (!row) throw new NotFoundError("Group");
    return row;
  }

  function activeOnDay(day: IsoDate): SQL | undefined {
    return and(eq(s.expenses.spentOn, day), isNull(s.expenses.deletedAt));
  }

  function bookFor(executor: Executor, expenses: readonly StoredExpense[]): Promise<RateBook> {
    return loadRateBook(
      expenses.map((expense) => ({
        date: expense.spentOn,
        currencies: [expense.currency, expense.billedCurrency],
      })),
      executor,
    );
  }

  async function auditReprice(
    tx: Tx,
    changes: readonly RepriceChange[],
    reason: "daily_rate.set" | "daily_rate.clear" | "daily_rate.reprice",
  ): Promise<void> {
    for (const change of changes) {
      await audit(tx, {
        action: "expense.reprice",
        entityType: "expense",
        entityId: change.expenseId,
        before: { pricing: change.before },
        after: {
          pricing: change.after,
          description: change.description,
          spentOn: change.spentOn,
          reason,
        },
      });
    }
  }

  /** SGD is the reporting currency: it has no exchange rate of its own to set, clear or re-price. */
  function assertForeign(currency: CurrencyCode): void {
    if (currency === REPORTING_CURRENCY) {
      throw new ConflictError("SGD needs no exchange rate: pick a foreign currency.");
    }
  }

  function dayRateKey(day: IsoDate, currency: CurrencyCode): SQL | undefined {
    return and(
      eq(s.dailyRates.groupId, groupId),
      eq(s.dailyRates.rateDate, day),
      eq(s.dailyRates.base, currency),
      eq(s.dailyRates.quote, REPORTING_CURRENCY),
    );
  }

  /** Changes (or removes) a day's default rate and re-prices that day's expenses in one transaction. */
  async function writeDayRate(change: {
    day: IsoDate;
    currency: CurrencyCode;
    rate: DailyRateInput["rate"] | null;
  }): Promise<RepriceResult> {
    return db.transaction(async (tx) => {
      const expenses = await readExpenses(tx, activeOnDay(change.day));
      const affected = expenses.filter((expense) => usesDayRate(expense, change.currency)).length;
      const before = await bookFor(tx, expenses);
      const [previous] = await tx
        .select()
        .from(s.dailyRates)
        .where(dayRateKey(change.day, change.currency))
        .for("update");
      const unchanged =
        change.rate === null
          ? previous === undefined
          : previous !== undefined && rateEquals(parseRate(previous.rate), change.rate);
      if (unchanged) return { affected, changes: [] };

      if (change.rate === null) {
        await tx.delete(s.dailyRates).where(dayRateKey(change.day, change.currency));
      } else {
        const at = now();
        await tx
          .insert(s.dailyRates)
          .values({
            groupId,
            rateDate: change.day,
            base: change.currency,
            quote: REPORTING_CURRENCY,
            rate: formatRate(change.rate),
            setBy: session.userId,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoUpdate({
            target: [
              s.dailyRates.groupId,
              s.dailyRates.rateDate,
              s.dailyRates.base,
              s.dailyRates.quote,
            ],
            set: { rate: formatRate(change.rate), setBy: session.userId, updatedAt: at },
          });
      }
      const after = await bookFor(tx, expenses);
      const changes = diffPricing(expenses, before, after);
      const describe = (rate: string | null) =>
        rate === null ? null : { day: change.day, currency: change.currency, rate };
      await audit(tx, {
        action: change.rate === null ? "daily_rate.clear" : "daily_rate.set",
        entityType: "daily_rate",
        entityId: null,
        before: describe(previous ? formatRate(parseRate(previous.rate)) : null),
        after: describe(change.rate ? formatRate(change.rate) : null),
      });
      await auditReprice(tx, changes, change.rate === null ? "daily_rate.clear" : "daily_rate.set");
      return { affected, changes };
    });
  }

  const store: LedgerStore = {
    session,
    members,

    async loadLedger() {
      const people = await members();
      const [expenses, settlements] = await Promise.all([
        readExpenses(db, isNull(s.expenses.deletedAt)),
        readSettlements(db, isNull(s.settlements.deletedAt)),
      ]);
      const book = await loadRateBook([
        ...expenses.map((e) => ({
          date: e.spentOn,
          currencies: [e.currency, e.billedCurrency],
        })),
        ...settlements.map((e) => ({
          date: e.settledOn,
          currencies: [e.currency, e.billedCurrency],
        })),
      ]);
      return { members: people, expenses, settlements, book };
    },

    async rateBookFor(records) {
      await members();
      return loadRateBook(
        records.map((record) => ({
          date: record.spentOn,
          currencies: [record.currency, record.billedCurrency],
        })),
      );
    },

    async listExpenses(listOptions = {}) {
      await members();
      return readExpenses(
        db,
        listOptions.deleted ? isNotNull(s.expenses.deletedAt) : isNull(s.expenses.deletedAt),
      );
    },

    async getExpense(id) {
      await members();
      return readExpense(db, id);
    },

    async listImportExpenses(importId) {
      await members();
      if (!UUID.test(importId)) return [];
      return readExpenses(db, eq(s.expenses.importId, importId));
    },

    async createExpense(input) {
      await members();
      await expenseInput(input);
      return db.transaction((tx) => insertExpense(tx, input));
    },

    async updateExpense(id, input, expectedUpdatedAt) {
      await members();
      assertId(id, "Expense");
      await expenseInput(input);
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ updatedAt: s.expenses.updatedAt, deletedAt: s.expenses.deletedAt })
          .from(s.expenses)
          .where(and(eq(s.expenses.groupId, groupId), eq(s.expenses.id, id)))
          .for("update");
        if (!locked) throw new NotFoundError("Expense");
        if (locked.deletedAt !== null) {
          throw new ConflictError("This expense was deleted. Restore it before editing.");
        }
        if (locked.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          throw new ConflictError("Someone else changed this expense while you were editing it.");
        }
        const before = await readExpense(tx, id);
        if (!before) throw new NotFoundError("Expense");

        await tx
          .update(s.expenses)
          .set({ ...expenseColumns(input), updatedAt: now() })
          .where(and(eq(s.expenses.groupId, groupId), eq(s.expenses.id, id)));
        await tx
          .delete(s.expensePayers)
          .where(and(eq(s.expensePayers.groupId, groupId), eq(s.expensePayers.expenseId, id)));
        await tx
          .delete(s.expenseShares)
          .where(and(eq(s.expenseShares.groupId, groupId), eq(s.expenseShares.expenseId, id)));
        await writePayersAndShares(tx, id, input);

        const after = await readExpense(tx, id);
        if (!after) throw new NotFoundError("Expense");
        await audit(tx, {
          action: "expense.update",
          entityType: "expense",
          entityId: id,
          before: snapshotExpense(before),
          after: snapshotExpense(after),
        });
        return after;
      });
    },

    deleteExpense: (id) => setExpenseDeleted(id, true),
    restoreExpense: (id) => setExpenseDeleted(id, false),

    async expenseHistory(id) {
      await members();
      assertId(id, "Expense");
      const [expense] = await db
        .select({ id: s.expenses.id })
        .from(s.expenses)
        .where(and(eq(s.expenses.groupId, groupId), eq(s.expenses.id, id)));
      if (!expense) throw new NotFoundError("Expense");
      const rows = await db
        .select()
        .from(s.auditLog)
        .where(
          and(
            eq(s.auditLog.groupId, groupId),
            eq(s.auditLog.entityType, "expense"),
            eq(s.auditLog.entityId, id),
          ),
        )
        .orderBy(asc(s.auditLog.id));
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorUserId: row.actorUserId,
        createdAt: row.createdAt,
        before: row.before,
        after: row.after,
      }));
    },

    async listSettlements(listOptions = {}) {
      await members();
      return readSettlements(
        db,
        listOptions.deleted ? isNotNull(s.settlements.deletedAt) : isNull(s.settlements.deletedAt),
      );
    },

    async loadDashboard() {
      const people = await members();
      const [expenses, budgets, trip] = await Promise.all([
        readExpenses(db, isNull(s.expenses.deletedAt)),
        readBudgets(),
        readTrip(db),
      ]);
      return { members: people, expenses, book: await bookFor(db, expenses), budgets, ...trip };
    },

    async updateTrip(input) {
      await members();
      return db.transaction(async (tx) => {
        const before = await readTrip(tx);
        await tx
          .update(s.groups)
          .set({
            tripStart: input.tripStart,
            tripEnd: input.tripEnd,
            timeZone: input.timeZone,
            updatedAt: now(),
          })
          .where(eq(s.groups.id, groupId));
        const after = await readTrip(tx);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          await audit(tx, {
            action: "trip.update",
            entityType: "group",
            entityId: groupId,
            before,
            after,
          });
        }
        return after;
      });
    },

    async setBudget(input) {
      await members();
      await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(s.budgets)
          .where(
            and(
              eq(s.budgets.groupId, groupId),
              input.day === null ? isNull(s.budgets.day) : eq(s.budgets.day, input.day),
            ),
          )
          .for("update");
        const at = now();
        let id: string;
        if (existing) {
          if (existing.amountMinor === input.amountMinor) return;
          id = existing.id;
          await tx
            .update(s.budgets)
            .set({ amountMinor: input.amountMinor, setBy: session.userId, updatedAt: at })
            .where(eq(s.budgets.id, id));
        } else {
          const [created] = await tx
            .insert(s.budgets)
            .values({
              groupId,
              day: input.day,
              amountMinor: input.amountMinor,
              setBy: session.userId,
              createdAt: at,
              updatedAt: at,
            })
            .returning({ id: s.budgets.id });
          if (!created) throw new Error("budget insert returned nothing");
          id = created.id;
        }
        await audit(tx, {
          action: "budget.set",
          entityType: "budget",
          entityId: id,
          before: existing ? { day: existing.day, amountMinor: existing.amountMinor } : null,
          after: { day: input.day, amountMinor: input.amountMinor },
        });
      });
    },

    async clearBudget(day) {
      await members();
      await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(s.budgets)
          .where(
            and(
              eq(s.budgets.groupId, groupId),
              day === null ? isNull(s.budgets.day) : eq(s.budgets.day, day),
            ),
          )
          .for("update");
        if (!existing) return;
        await tx.delete(s.budgets).where(eq(s.budgets.id, existing.id));
        await audit(tx, {
          action: "budget.clear",
          entityType: "budget",
          entityId: existing.id,
          before: { day: existing.day, amountMinor: existing.amountMinor },
          after: null,
        });
      });
    },

    async listDayRates(currency) {
      await members();
      const rows = await db
        .select()
        .from(s.dailyRates)
        .where(
          and(
            eq(s.dailyRates.groupId, groupId),
            eq(s.dailyRates.base, currency),
            eq(s.dailyRates.quote, REPORTING_CURRENCY),
          ),
        )
        .orderBy(asc(s.dailyRates.rateDate));
      return rows.map((row) => ({
        day: row.rateDate,
        currency,
        rate: formatRate(parseRate(row.rate)),
      }));
    },

    async listMarketRates(currency, from, to) {
      await members();
      const rows = await db
        .select()
        .from(s.fxRates)
        .where(
          and(
            eq(s.fxRates.base, currency),
            eq(s.fxRates.quote, REPORTING_CURRENCY),
            gte(s.fxRates.rateDate, from),
            lte(s.fxRates.rateDate, to),
          ),
        )
        .orderBy(asc(s.fxRates.rateDate));
      return rows.map((row) => ({
        day: row.rateDate,
        currency,
        rate: formatRate(parseRate(row.rate)),
      }));
    },

    async setDailyRate(input) {
      await members();
      assertForeign(input.currency);
      return writeDayRate({ day: input.day, currency: input.currency, rate: input.rate });
    },

    async clearDailyRate(input) {
      await members();
      assertForeign(input.currency);
      // Without the day rate the market rate decides, so it must be on file before the day rate goes.
      const expenses = await readExpenses(db, activeOnDay(input.day));
      const dayRates = await db
        .select()
        .from(s.dailyRates)
        .where(dayRateKey(input.day, input.currency));
      if (dayRates.length > 0 && expenses.some((expense) => usesDayRate(expense, input.currency))) {
        await storeMarketRate(input.day, input.currency);
      }
      return writeDayRate({ day: input.day, currency: input.currency, rate: null });
    },

    async repriceDay(input) {
      await members();
      assertForeign(input.currency);
      const expenses = await readExpenses(db, activeOnDay(input.day));
      const before = await bookFor(db, expenses);
      // A day whose market rate was never stored leaves its expenses unpriced: fetch it once.
      const missing = expenses.some(
        (expense) =>
          usesDayRate(expense, input.currency) &&
          expenseMarketRateNeeded(expense, before) === input.currency,
      );
      if (missing) await storeMarketRate(input.day, input.currency);

      return db.transaction(async (tx) => {
        const current = await readExpenses(tx, activeOnDay(input.day));
        const after = await bookFor(tx, current);
        const changes = diffPricing(current, before, after);
        const affected = current.filter((expense) => usesDayRate(expense, input.currency)).length;
        await audit(tx, {
          action: "daily_rate.reprice",
          entityType: "daily_rate",
          entityId: null,
          before: null,
          after: {
            day: input.day,
            currency: input.currency,
            affected,
            changed: changes.length,
          },
        });
        await auditReprice(tx, changes, "daily_rate.reprice");
        return { affected, changes };
      });
    },

    async createSettlement(input) {
      await members();
      await assertMembers([input.fromUserId, input.toUserId]);
      await ensureMarketRate({
        date: input.settledOn,
        needed: (overrides) => marketRateNeeded(toConvertible(input), overrides),
      });
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(s.settlements)
          .values({
            groupId,
            fromUserId: input.fromUserId,
            toUserId: input.toUserId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            billedAmountMinor: input.billed?.amountMinor ?? null,
            billedCurrency: input.billed?.currency ?? null,
            rate: input.rate ? formatRate(input.rate.rate) : null,
            rateCurrency: input.rate?.currency ?? null,
            settledOn: input.settledOn,
            note: input.note,
            createdBy: session.userId,
            createdAt: now(),
          })
          .returning({ id: s.settlements.id });
        if (!row) throw new Error("settlement insert returned nothing");
        const created = await readSettlement(tx, row.id);
        if (!created) throw new Error("settlement vanished after insert");
        await audit(tx, {
          action: "settlement.create",
          entityType: "settlement",
          entityId: row.id,
          before: null,
          after: snapshotSettlement(created),
        });
        return created;
      });
    },

    deleteSettlement: (id) => setSettlementDeleted(id, true),
    restoreSettlement: (id) => setSettlementDeleted(id, false),
  };

  return {
    store,
    session,
    now,
    async prepareExpense(input) {
      await members();
      try {
        await expenseInput(input);
        return { priced: true };
      } catch (error) {
        // A weekend or an outage must not block adding twelve rows: the expense is added and
        // shows "No rate" until someone sets one, like any other expense without a rate.
        if (error instanceof RateUnavailableError) return { priced: false };
        throw error;
      }
    },
    insertExpense,
    deleteExpenseIn: (tx, id) => setExpenseDeletedIn(tx, id, true),
    audit,
  };
}

function toConvertible(input: SettlementInput) {
  return {
    date: input.settledOn,
    amountMinor: input.amountMinor,
    currency: input.currency,
    billed: input.billed ?? undefined,
    rate: input.rate ?? undefined,
  };
}
