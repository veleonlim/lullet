import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import type { Session } from "@/lib/auth/session";
import { FxRateError, type FxRateClient } from "@/lib/fx";
import {
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
  rateEntryFromRow,
  REPORTING_CURRENCY,
  type CurrencyCode,
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
  createExpense(input: ExpenseInput): Promise<StoredExpense>;
  /** `expectedUpdatedAt` guards against overwriting someone else's edit. */
  updateExpense(id: string, input: ExpenseInput, expectedUpdatedAt: Date): Promise<StoredExpense>;
  deleteExpense(id: string): Promise<StoredExpense>;
  restoreExpense(id: string): Promise<StoredExpense>;
  /** Who changed what, oldest first. */
  expenseHistory(id: string): Promise<AuditEntry[]>;
  listSettlements(options?: { deleted?: boolean }): Promise<StoredSettlement[]>;
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

export function createLedgerStore(options: StoreOptions): LedgerStore {
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
    const market = await db
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
    const overrides = await db
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

    const [stored] = await db
      .select({ rate: s.fxRates.rate })
      .from(s.fxRates)
      .where(
        and(
          eq(s.fxRates.rateDate, amount.date),
          eq(s.fxRates.base, currency),
          eq(s.fxRates.quote, REPORTING_CURRENCY),
        ),
      )
      .limit(1);
    if (stored) return;

    let quote;
    try {
      quote = await fx.getRate(amount.date, currency, REPORTING_CURRENCY);
    } catch (error) {
      if (error instanceof FxRateError) throw new RateUnavailableError(currency, amount.date);
      throw error;
    }
    await db
      .insert(s.fxRates)
      .values({
        rateDate: amount.date,
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
      entityType: "expense" | "settlement";
      entityId: string;
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

  async function setExpenseDeleted(id: string, deleted: boolean): Promise<StoredExpense> {
    await members();
    assertId(id, "Expense");
    return db.transaction(async (tx) => {
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
    });
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

  return {
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

    async createExpense(input) {
      await members();
      await expenseInput(input);
      return db.transaction(async (tx) => {
        const at = now();
        const [row] = await tx
          .insert(s.expenses)
          .values({
            ...expenseColumns(input),
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
      });
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
