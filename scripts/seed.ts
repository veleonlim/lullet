/**
 * `pnpm db:seed` creates the four members and the trip group for local development.
 *   --reset  also empties the ledger first
 *   --demo   also adds a few sample expenses (implies a fresh ledger)
 */
import { createDatabase } from "@/db/client";
import { SEED_GROUP_ID, SEED_MEMBERS } from "@/db/seed-ids";
import { resetLedger, seedDevelopmentData } from "@/db/seed";
import {
  blankExpenseForm,
  blankSettlementForm,
  validateExpenseForm,
  validateSettlementForm,
  type ExpenseFormValues,
  type Member,
} from "@/lib/ledger";
import { FxRateError, type FxRateClient } from "@/lib/fx";
import { createLedgerStore } from "@/server/ledger";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env (see the README).");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const { db, pool } = createDatabase({ connectionString, max: 2 });

// The seeded market rates cover the demo days, so nothing is fetched from the network.
const offline: FxRateClient = {
  getRate: (date, base, quote) =>
    Promise.reject(new FxRateError("not_found", `offline seed: no ${base}/${quote} on ${date}`)),
};

async function addDemoData(): Promise<void> {
  const members: Member[] = SEED_MEMBERS.map((member, position) => ({
    userId: member.id,
    displayName: member.displayName,
    position,
  }));
  const order = members.map((member) => member.userId);
  const [alex = "", jamie = "", mum = "", dad = ""] = order;
  const as = (userId: string) =>
    createLedgerStore({ db, session: { userId, groupId: SEED_GROUP_ID }, fx: offline });

  const expense = async (payer: string, overrides: Partial<ExpenseFormValues>): Promise<void> => {
    const form: ExpenseFormValues = {
      ...blankExpenseForm({ members, payerUserId: payer, today: "2026-11-02" }),
      ...overrides,
    };
    const result = validateExpenseForm(form, order);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    await as(payer).createExpense(result.value);
  };

  await expense(alex, {
    description: "Airport train to the city",
    spentOn: "2026-11-02",
    category: "transport",
    amount: "13.20",
    currency: "CHF",
  });
  await expense(mum, {
    description: "Dinner at Trattoria Roma",
    spentOn: "2026-11-03",
    category: "food",
    amount: "148.49",
    currency: "EUR",
  });
  await expense(jamie, {
    description: "Hotel Lumiere, 2 nights",
    spentOn: "2026-11-03",
    category: "stay",
    amount: "424.80",
    currency: "EUR",
    billed: { amount: "640.00", currency: "SGD" },
  });
  await expense(dad, {
    description: "Colosseum tickets",
    spentOn: "2026-11-04",
    category: "sightseeing",
    amount: "64.00",
    currency: "EUR",
    split: {
      mode: "equal",
      members: order.map((userId) => ({ userId, included: userId !== jamie, value: "" })),
    },
  });
  await expense(alex, {
    description: "Gelato",
    spentOn: "2026-11-04",
    category: "food",
    amount: "9.50",
    currency: "EUR",
  });

  const settlement = validateSettlementForm(
    blankSettlementForm({ fromUserId: dad, toUserId: alex, amount: "30.00", today: "2026-11-05" }),
    order,
  );
  if (!settlement.ok) throw new Error(JSON.stringify(settlement.errors));
  await as(dad).createSettlement(settlement.value);
}

try {
  if (args.has("--reset") || args.has("--demo")) await resetLedger(db, connectionString);
  await seedDevelopmentData(db, connectionString);
  if (args.has("--demo")) await addDemoData();
  console.log(
    `Seeded ${String(SEED_MEMBERS.length)} members in the trip group${args.has("--demo") ? " with demo expenses" : ""}.`,
  );
} finally {
  await pool.end();
}
