import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { createDatabase, type Database, type DatabaseHandle } from "@/db/client";
import * as s from "@/db/schema";
import { bootstrapGroup } from "@/lib/auth/db/members";

let handle: DatabaseHandle | undefined;

export function testDb(): Database {
  if (!handle) {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) throw new Error("TEST_DATABASE_URL was not provided by global setup");
    handle = createDatabase({ connectionString, max: 4 });
  }
  return handle.db;
}

export async function closeTestDb(): Promise<void> {
  await handle?.pool.end();
  handle = undefined;
}

/** Removes every row (TRUNCATE skips row triggers, so soft-delete-only tables can be reset). */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE users, groups, fx_rates RESTART IDENTITY CASCADE`);
}

export interface Seed {
  readonly groupId: string;
  /** Members in their fixed order (position 0..n-1). */
  readonly userIds: readonly string[];
}

export async function seedGroup(db: Database, memberCount = 4): Promise<Seed> {
  const [group] = await db.insert(s.groups).values({ name: "Switzerland and Italy" }).returning();
  if (!group) throw new Error("group insert returned nothing");
  const users = await db
    .insert(s.users)
    .values(Array.from({ length: memberCount }, (_, i) => ({ displayName: `Member ${i + 1}` })))
    .returning();
  await db
    .insert(s.memberships)
    .values(users.map((user, position) => ({ groupId: group.id, userId: user.id, position })));
  return { groupId: group.id, userIds: users.map((u) => u.id) };
}

export interface NewExpense {
  readonly seed: Seed;
  readonly amountMinor: number;
  readonly currency?: string;
  readonly payers: readonly { userId: string; amountMinor: number }[];
  readonly shares: readonly { userId: string; amountMinor: number; weight?: number }[];
  readonly spentOn?: string;
  readonly billed?: { amountMinor: number; currency: string };
  readonly rate?: { rate: string; currency: string };
}

/** Inserts an expense with its payers and shares in one transaction, as the app must. */
export async function insertExpense(db: Database, input: NewExpense): Promise<string> {
  return db.transaction(async (tx) => {
    const [expense] = await tx
      .insert(s.expenses)
      .values({
        groupId: input.seed.groupId,
        description: "Trattoria",
        spentOn: input.spentOn ?? "2026-11-02",
        amountMinor: input.amountMinor,
        currency: input.currency ?? "EUR",
        billedAmountMinor: input.billed?.amountMinor,
        billedCurrency: input.billed?.currency,
        rate: input.rate?.rate,
        rateCurrency: input.rate?.currency,
        createdBy: input.payers[0]?.userId ?? input.seed.userIds[0] ?? "",
      })
      .returning({ id: s.expenses.id });
    if (!expense) throw new Error("expense insert returned nothing");
    await tx
      .insert(s.expensePayers)
      .values(
        input.payers.map((p) => ({ expenseId: expense.id, groupId: input.seed.groupId, ...p })),
      );
    await tx
      .insert(s.expenseShares)
      .values(
        input.shares.map((p) => ({ expenseId: expense.id, groupId: input.seed.groupId, ...p })),
      );
    return expense.id;
  });
}

/** Collects `code`/`constraint` from an error and its causes (Drizzle wraps driver errors). */
function pgDetails(error: unknown): { code?: string; constraint?: string; message: string } {
  const details: { code?: string; constraint?: string; message: string } = { message: "" };
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const candidate = current as Error & { code?: string; constraint?: string };
    details.message += `${candidate.message}\n`;
    if (typeof candidate.code === "string" && !details.code) details.code = candidate.code;
    if (typeof candidate.constraint === "string" && !details.constraint) {
      details.constraint = candidate.constraint;
    }
    current = candidate.cause;
  }
  return details;
}

/** Asserts the promise fails with the given Postgres SQLSTATE (and optionally constraint). */
export async function expectPgError(
  promise: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected the statement to be rejected by the database").toBeDefined();
  const details = pgDetails(caught);
  expect(details.code, details.message).toBe(expected.code);
  if (expected.constraint) expect(details.constraint, details.message).toBe(expected.constraint);
}

export const PG = {
  checkViolation: "23514",
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  restrictViolation: "23001",
} as const;

export interface AuthSeed extends Seed {
  /** Telegram user ids of the members, in member order. The first member is the owner. */
  readonly telegramIds: readonly number[];
}

/** A four member group where every member is linked to a Telegram account (the allowlist). */
export async function seedAllowlistedGroup(db: Database): Promise<AuthSeed> {
  const telegramIds = [1001, 1002, 1003, 1004];
  const { groupId, userIds } = await bootstrapGroup(
    {
      groupName: "Switzerland and Italy",
      members: telegramIds.map((telegramUserId, i) => ({
        displayName: `Member ${i + 1}`,
        telegramUserId,
      })),
    },
    { db, secret: TEST_SECRET },
  );
  return { groupId, userIds, telegramIds };
}

export const TEST_SECRET = "integration-test-secret-0123456789abcdef";
