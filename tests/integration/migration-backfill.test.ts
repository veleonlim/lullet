import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import {
  createRateBook,
  MoneyError,
  parseRate,
  toReportingCurrency,
  type ConvertibleAmount,
  type CurrencyCode,
  type RateBook,
} from "@/lib/money";

/**
 * The trip settings migration gives every expense and settlement the rate it is priced with. Rows
 * saved before it have to start out with exactly the figure they show today: the migration is run
 * over a database built to the previous migration and filled with such rows.
 */

const UNDER_TEST = "0007_trip_settings";

interface Row {
  readonly label: string;
  readonly group: "A" | "B";
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
  readonly billed?: { amountMinor: number; currency: CurrencyCode };
  readonly rate?: { rate: string; currency: CurrencyCode };
  /** What the row must carry after the migration: SGD per unit, currency, source; null for no stored rate. */
  readonly expected: readonly [string, CurrencyCode, "day_override" | "market"] | null;
}

const EXPENSES: readonly Row[] = [
  {
    label: "day rate",
    group: "A",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 10000,
    expected: ["1.6000000000", "EUR", "day_override"],
  },
  {
    label: "market",
    group: "A",
    date: "2026-11-03",
    currency: "EUR",
    amountMinor: 10000,
    expected: ["1.4000000000", "EUR", "market"],
  },
  {
    label: "billed in francs",
    group: "A",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 10000,
    billed: { amountMinor: 5000, currency: "CHF" },
    expected: ["1.6000000000", "CHF", "market"],
  },
  {
    label: "native",
    group: "A",
    date: "2026-11-02",
    currency: "SGD",
    amountMinor: 10000,
    expected: null,
  },
  {
    label: "billed in SGD",
    group: "A",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 10000,
    billed: { amountMinor: 12345, currency: "SGD" },
    expected: null,
  },
  {
    label: "own rate",
    group: "A",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 10000,
    rate: { rate: "1.7", currency: "EUR" },
    expected: null,
  },
  {
    label: "own rate for another currency",
    group: "A",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 10000,
    rate: { rate: "1.7", currency: "CHF" },
    expected: ["1.6000000000", "EUR", "day_override"],
  },
  {
    label: "no rate anywhere",
    group: "A",
    date: "2026-11-09",
    currency: "EUR",
    amountMinor: 10000,
    expected: null,
  },
  {
    label: "another group's day rate",
    group: "B",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 10000,
    expected: ["9.0000000000", "EUR", "day_override"],
  },
];

const SETTLEMENTS: readonly Row[] = [
  {
    label: "euro settlement",
    group: "A",
    date: "2026-11-02",
    currency: "EUR",
    amountMinor: 1000,
    expected: ["1.6000000000", "EUR", "day_override"],
  },
  {
    label: "sgd settlement",
    group: "A",
    date: "2026-11-02",
    currency: "SGD",
    amountMinor: 1000,
    expected: null,
  },
];

/** The rates in force before the migration, as the app priced from them then. */
const LIVE_BOOKS: Record<"A" | "B", RateBook> = {
  A: createRateBook({
    overrides: [{ date: "2026-11-02", currency: "EUR", rate: "1.6" }],
    market: [
      { date: "2026-11-02", currency: "EUR", rate: "1.5" },
      { date: "2026-11-02", currency: "CHF", rate: "1.6" },
      { date: "2026-11-03", currency: "EUR", rate: "1.4" },
    ],
  }),
  B: createRateBook({
    overrides: [{ date: "2026-11-02", currency: "EUR", rate: "9" }],
    market: [{ date: "2026-11-02", currency: "EUR", rate: "1.5" }],
  }),
};

function figure(amount: ConvertibleAmount, book: RateBook): number | null {
  try {
    return toReportingCurrency(amount, book).sgdMinor;
  } catch (error) {
    if (error instanceof MoneyError && error.code === "missing_rate") return null;
    throw error;
  }
}

function amountOf(row: Row): ConvertibleAmount {
  return {
    date: row.date,
    amountMinor: row.amountMinor,
    currency: row.currency,
    billed: row.billed,
    rate: row.rate ? { currency: row.rate.currency, rate: parseRate(row.rate.rate) } : undefined,
  };
}

interface PricedRow {
  readonly description: string;
  readonly priced_rate: string | null;
  readonly priced_rate_currency: string | null;
  readonly priced_source: "day_override" | "market" | null;
}

describe("the migration that stores the rate each amount was priced with", () => {
  const name = `lullet_mig_${randomBytes(6).toString("hex")}`;
  const folder = mkdtempSync(join(tmpdir(), "lullet-migrations-"));
  let admin: Client | undefined;
  let handle: DatabaseHandle | undefined;
  let expenses: PricedRow[];
  let settlements: PricedRow[];

  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base) throw new Error("TEST_DATABASE_URL was not provided by global setup");
    admin = new Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(base);
    url.pathname = `/${name}`;
    handle = createDatabase({ connectionString: url.toString(), max: 2 });

    // A copy of the migrations up to, but not including, the one under test, to build the database as
    // it was before. Later migrations are cut too: the migrator skips any migration older than the
    // last one applied, so applying a later one first would make the full run skip the one under test.
    cpSync("drizzle", folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const cut = journal.entries.findIndex((entry) => entry.tag === UNDER_TEST);
    if (cut < 0) throw new Error(`migration ${UNDER_TEST} is not in the journal`);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    await runMigrations(handle.db, folder);

    const pool = handle.pool;
    const ids = { A: { group: "", user: "" }, B: { group: "", user: "" } };
    for (const key of ["A", "B"] as const) {
      const group = await pool.query<{ id: string }>(
        `INSERT INTO groups (name) VALUES ($1) RETURNING id`,
        [`Group ${key}`],
      );
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
        [`User ${key}`],
      );
      ids[key] = { group: group.rows[0]?.id ?? "", user: user.rows[0]?.id ?? "" };
      await pool.query(
        `INSERT INTO memberships (group_id, user_id, position) VALUES ($1, $2, 0), ($1, $3, 1)`,
        [
          ids[key].group,
          ids[key].user,
          (
            await pool.query<{ id: string }>(
              `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
              [`Other ${key}`],
            )
          ).rows[0]?.id,
        ],
      );
    }
    for (const [date, base_, rate] of [
      ["2026-11-02", "EUR", "1.5"],
      ["2026-11-02", "CHF", "1.6"],
      ["2026-11-03", "EUR", "1.4"],
    ] as const) {
      await pool.query(
        `INSERT INTO fx_rates (rate_date, base, quote, rate, source_date) VALUES ($1, $2, 'SGD', $3, $1)`,
        [date, base_, rate],
      );
    }
    await pool.query(
      `INSERT INTO daily_rates (group_id, rate_date, base, quote, rate, set_by) VALUES ($1, '2026-11-02', 'EUR', 'SGD', 1.6, $2), ($3, '2026-11-02', 'EUR', 'SGD', 9, $4)`,
      [ids.A.group, ids.A.user, ids.B.group, ids.B.user],
    );

    for (const row of EXPENSES) {
      const { group, user } = ids[row.group];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO expenses (group_id, description, spent_on, amount_minor, currency, billed_amount_minor, billed_currency, rate, rate_currency, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            group,
            row.label,
            row.date,
            row.amountMinor,
            row.currency,
            row.billed?.amountMinor ?? null,
            row.billed?.currency ?? null,
            row.rate?.rate ?? null,
            row.rate?.currency ?? null,
            user,
          ],
        );
        const id = inserted.rows[0]?.id;
        await client.query(
          `INSERT INTO expense_payers (expense_id, group_id, user_id, amount_minor) VALUES ($1, $2, $3, $4)`,
          [id, group, user, row.amountMinor],
        );
        await client.query(
          `INSERT INTO expense_shares (expense_id, group_id, user_id, amount_minor) VALUES ($1, $2, $3, $4)`,
          [id, group, user, row.amountMinor],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    for (const row of SETTLEMENTS) {
      const { group } = ids[row.group];
      const [from, to] = (
        await pool.query<{ user_id: string }>(
          `SELECT user_id FROM memberships WHERE group_id = $1 ORDER BY position`,
          [group],
        )
      ).rows;
      await pool.query(
        `INSERT INTO settlements (group_id, from_user_id, to_user_id, amount_minor, currency, settled_on, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $2)`,
        [group, from?.user_id, to?.user_id, row.amountMinor, row.currency, row.date, row.label],
      );
    }

    await runMigrations(handle.db);

    const read = (table: "expenses" | "settlements", label: string) =>
      pool.query<PricedRow>(
        `SELECT ${label} AS description, priced_rate, priced_rate_currency, priced_source FROM ${table} ORDER BY ${label}`,
      );
    expenses = (await read("expenses", "description")).rows;
    settlements = (await read("settlements", "note")).rows;
  });

  afterAll(async () => {
    await handle?.pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
    rmSync(folder, { recursive: true, force: true });
  });

  function pricedOf(rows: PricedRow[], label: string): PricedRow {
    const found = rows.find((row) => row.description === label);
    if (!found) throw new Error(`no row ${label}`);
    return found;
  }

  it.each(EXPENSES)("gives the expense '$label' the rate it is priced with today", (row) => {
    const found = pricedOf(expenses, row.label);
    expect(
      found.priced_rate === null
        ? null
        : [found.priced_rate, found.priced_rate_currency, found.priced_source],
    ).toEqual(row.expected);
  });

  it.each(SETTLEMENTS)("gives the settlement '$label' the rate it is priced with today", (row) => {
    const found = pricedOf(settlements, row.label);
    expect(
      found.priced_rate === null
        ? null
        : [found.priced_rate, found.priced_rate_currency, found.priced_source],
    ).toEqual(row.expected);
  });

  it("leaves every figure exactly as the rate book priced it before the migration", () => {
    for (const [rows, stored] of [
      [EXPENSES, expenses],
      [SETTLEMENTS, settlements],
    ] as const) {
      for (const row of rows) {
        const found = pricedOf(stored, row.label);
        const before = figure(amountOf(row), LIVE_BOOKS[row.group]);
        const after = figure(
          {
            ...amountOf(row),
            priced:
              found.priced_rate !== null &&
              found.priced_rate_currency !== null &&
              found.priced_source !== null
                ? {
                    currency: found.priced_rate_currency as CurrencyCode,
                    rate: parseRate(found.priced_rate),
                    source: found.priced_source,
                  }
                : undefined,
          },
          createRateBook({}),
        );
        expect({ label: row.label, figure: after }).toEqual({ label: row.label, figure: before });
      }
    }
  });
});
