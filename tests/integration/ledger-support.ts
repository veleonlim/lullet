import type { Database } from "@/db/client";
import { FxRateError, type FxRateClient, type FxRateQuote } from "@/lib/fx";
import {
  blankExpenseForm,
  blankSettlementForm,
  validateExpenseForm,
  validateSettlementForm,
  type ExpenseFormValues,
  type ExpenseInput,
  type Member,
  type SettlementFormValues,
  type SettlementInput,
} from "@/lib/ledger";
import { parseRate, type CurrencyCode, type IsoDate } from "@/lib/money";
import { createLedgerStore, type LedgerStore } from "@/server/ledger";
import { seedGroup, type Seed } from "./helpers";

/** A scripted exchange rate source: fixed SGD rates per currency, counting every call. */
export class FakeFx implements FxRateClient {
  readonly calls: string[] = [];

  constructor(private readonly rates: Partial<Record<CurrencyCode, string>>) {}

  getRate(date: IsoDate, base: CurrencyCode, quote: CurrencyCode): Promise<FxRateQuote> {
    this.calls.push(`${date}|${base}|${quote}`);
    const rate = this.rates[base];
    if (rate === undefined) {
      return Promise.reject(new FxRateError("not_found", `no ${base} rate`));
    }
    return Promise.resolve({
      provider: "fake",
      base,
      quote,
      requestedDate: date,
      rateDate: date,
      rate: parseRate(rate),
    });
  }
}

export const RATES = { EUR: "1.5", CHF: "1.6" } as const;

export function storeFor(
  db: Database,
  seed: Seed,
  options: { as?: number; fx?: FxRateClient } = {},
): LedgerStore {
  const userId = seed.userIds[options.as ?? 0];
  if (userId === undefined) throw new Error("no such member");
  return createLedgerStore({
    db,
    session: { userId, groupId: seed.groupId },
    fx: options.fx ?? new FakeFx(RATES),
  });
}

export function membersOf(seed: Seed): Member[] {
  return seed.userIds.map((userId, position) => ({
    userId,
    displayName: `Member ${String(position + 1)}`,
    position,
  }));
}

export function expenseInput(
  seed: Seed,
  overrides: Partial<ExpenseFormValues> = {},
  payer = 0,
): ExpenseInput {
  const payerUserId = seed.userIds[payer];
  if (payerUserId === undefined) throw new Error("no such member");
  const form: ExpenseFormValues = {
    ...blankExpenseForm({ members: membersOf(seed), payerUserId, today: "2026-11-02" }),
    description: "Trattoria",
    amount: "148.49",
    ...overrides,
  };
  const result = validateExpenseForm(form, seed.userIds);
  if (!result.ok) throw new Error(`invalid test expense: ${JSON.stringify(result.errors)}`);
  return result.value;
}

export function settlementInput(
  seed: Seed,
  overrides: Partial<SettlementFormValues> = {},
  from = 1,
  to = 0,
): SettlementInput {
  const fromUserId = seed.userIds[from];
  const toUserId = seed.userIds[to];
  if (fromUserId === undefined || toUserId === undefined) throw new Error("no such member");
  const form = {
    ...blankSettlementForm({ fromUserId, toUserId, amount: "50.00", today: "2026-11-05" }),
    ...overrides,
  };
  const result = validateSettlementForm(form, seed.userIds);
  if (!result.ok) throw new Error(`invalid test settlement: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** Two independent groups, each with four members. */
export async function seedTwoGroups(db: Database): Promise<{ a: Seed; b: Seed }> {
  const a = await seedGroup(db, 4);
  const b = await seedGroup(db, 4);
  return { a, b };
}
