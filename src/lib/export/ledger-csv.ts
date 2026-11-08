import { isCurrencyCode, minorUnitExponent } from "@/lib/money";
import { toCsv, type CsvCell } from "./csv";

/**
 * Turns a copy of the ledger tables into spreadsheet files: one CSV per table, with member names
 * in place of ids and amounts shown as decimals next to the exact integer minor units. The
 * export is complete (deleted rows and the audit log included), so it doubles as a backup that
 * can be read without lullet.
 */

type Instant = Date | null;

export interface ExportData {
  readonly users: readonly { id: string; displayName: string }[];
  readonly groups: readonly {
    id: string;
    name: string;
    tripStart: string | null;
    tripEnd: string | null;
    timeZone: string;
  }[];
  readonly memberships: readonly {
    groupId: string;
    userId: string;
    position: number;
    isOwner: boolean;
  }[];
  readonly telegramLinks: readonly {
    userId: string;
    telegramUserId: number;
    username: string | null;
  }[];
  readonly expenses: readonly {
    id: string;
    groupId: string;
    importId: string | null;
    spentOn: string;
    description: string;
    category: string;
    amountMinor: number;
    currency: string;
    billedAmountMinor: number | null;
    billedCurrency: string | null;
    rate: string | null;
    rateCurrency: string | null;
    pricedRate: string | null;
    pricedRateCurrency: string | null;
    pricedSource: string | null;
    splitMethod: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Instant;
    deletedBy: string | null;
  }[];
  readonly expensePayers: readonly { expenseId: string; userId: string; amountMinor: number }[];
  readonly expenseShares: readonly {
    expenseId: string;
    userId: string;
    amountMinor: number;
    weight: number | null;
  }[];
  readonly settlements: readonly {
    id: string;
    groupId: string;
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
    currency: string;
    billedAmountMinor: number | null;
    billedCurrency: string | null;
    rate: string | null;
    rateCurrency: string | null;
    pricedRate: string | null;
    pricedRateCurrency: string | null;
    pricedSource: string | null;
    settledOn: string;
    note: string | null;
    createdBy: string;
    createdAt: Date;
    deletedAt: Instant;
    deletedBy: string | null;
  }[];
  readonly budgets: readonly {
    groupId: string;
    day: string | null;
    amountMinor: number;
    setBy: string;
    updatedAt: Date;
  }[];
  readonly dailyRates: readonly {
    groupId: string;
    rateDate: string;
    base: string;
    quote: string;
    rate: string;
    setBy: string;
    updatedAt: Date;
  }[];
  readonly fxRates: readonly {
    rateDate: string;
    base: string;
    quote: string;
    rate: string;
    sourceDate: string;
    provider: string;
    fetchedAt: Date;
  }[];
  readonly auditLog: readonly {
    id: number;
    groupId: string | null;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    before: unknown;
    after: unknown;
    createdAt: Date;
  }[];
}

export interface ExportFile {
  readonly name: string;
  readonly rows: number;
  readonly content: string;
}

/** 1234 EUR becomes "12.34", 500 JPY becomes "500"; an unknown currency keeps the minor units. */
export function formatMinor(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null) return "";
  if (currency === null || !isCurrencyCode(currency)) return String(amountMinor);
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) return String(amountMinor);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

const json = (value: unknown): string =>
  value === null || value === undefined ? "" : JSON.stringify(value);

export function buildExportFiles(data: ExportData): ExportFile[] {
  const nameOf = new Map(data.users.map((user) => [user.id, user.displayName]));
  const groupOf = new Map(data.groups.map((group) => [group.id, group.name]));
  const who = (userId: string | null): string =>
    userId === null ? "" : (nameOf.get(userId) ?? userId);
  const expenseCurrency = new Map(data.expenses.map((e) => [e.id, e.currency]));

  const file = (
    name: string,
    columns: readonly string[],
    rows: readonly (readonly CsvCell[])[],
  ): ExportFile => ({ name, rows: rows.length, content: toCsv(columns, rows) });

  const summary = (
    parts: readonly { userId: string; amountMinor: number }[],
    currency: string,
  ): string =>
    parts
      .map((part) => `${who(part.userId)} ${formatMinor(part.amountMinor, currency)}`)
      .join("; ");

  const telegram = new Map(data.telegramLinks.map((link) => [link.userId, link]));
  const members = file(
    "members.csv",
    ["group", "position", "name", "is_owner", "telegram_user_id", "telegram_username"],
    [...data.memberships]
      .sort((a, b) => a.groupId.localeCompare(b.groupId) || a.position - b.position)
      .map((m) => [
        groupOf.get(m.groupId) ?? m.groupId,
        m.position,
        who(m.userId),
        m.isOwner,
        telegram.get(m.userId)?.telegramUserId,
        telegram.get(m.userId)?.username,
      ]),
  );

  const groups = file(
    "groups.csv",
    ["id", "name", "trip_start", "trip_end", "time_zone"],
    data.groups.map((g) => [g.id, g.name, g.tripStart, g.tripEnd, g.timeZone]),
  );

  const sortedExpenses = [...data.expenses].sort(
    (a, b) => a.spentOn.localeCompare(b.spentOn) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const expenses = file(
    "expenses.csv",
    [
      "id",
      "group",
      "spent_on",
      "description",
      "category",
      "amount",
      "currency",
      "amount_minor",
      "billed_amount",
      "billed_currency",
      "rate_sgd_per_unit",
      "rate_currency",
      "priced_rate",
      "priced_rate_currency",
      "priced_source",
      "split_method",
      "paid_by",
      "split_between",
      "created_by",
      "created_at",
      "updated_at",
      "deleted_at",
      "deleted_by",
      "import_id",
    ],
    sortedExpenses.map((e) => [
      e.id,
      groupOf.get(e.groupId) ?? e.groupId,
      e.spentOn,
      e.description,
      e.category,
      formatMinor(e.amountMinor, e.currency),
      e.currency,
      e.amountMinor,
      formatMinor(e.billedAmountMinor, e.billedCurrency),
      e.billedCurrency,
      e.rate,
      e.rateCurrency,
      e.pricedRate,
      e.pricedRateCurrency,
      e.pricedSource,
      e.splitMethod,
      summary(
        data.expensePayers.filter((p) => p.expenseId === e.id),
        e.currency,
      ),
      summary(
        data.expenseShares.filter((p) => p.expenseId === e.id),
        e.currency,
      ),
      who(e.createdBy),
      e.createdAt,
      e.updatedAt,
      e.deletedAt,
      who(e.deletedBy),
      e.importId,
    ]),
  );

  const describedParts = (
    name: string,
    parts: readonly {
      expenseId: string;
      userId: string;
      amountMinor: number;
      weight?: number | null;
    }[],
    withWeight: boolean,
  ): ExportFile =>
    file(
      name,
      [
        "expense_id",
        "member",
        "amount",
        "currency",
        "amount_minor",
        ...(withWeight ? ["weight"] : []),
      ],
      parts.map((part) => [
        part.expenseId,
        who(part.userId),
        formatMinor(part.amountMinor, expenseCurrency.get(part.expenseId) ?? null),
        expenseCurrency.get(part.expenseId),
        part.amountMinor,
        ...(withWeight ? [part.weight] : []),
      ]),
    );

  const settlements = file(
    "settlements.csv",
    [
      "id",
      "group",
      "settled_on",
      "from",
      "to",
      "amount",
      "currency",
      "amount_minor",
      "billed_amount",
      "billed_currency",
      "rate_sgd_per_unit",
      "rate_currency",
      "priced_rate",
      "priced_rate_currency",
      "priced_source",
      "note",
      "created_by",
      "created_at",
      "deleted_at",
      "deleted_by",
    ],
    [...data.settlements]
      .sort(
        (a, b) =>
          a.settledOn.localeCompare(b.settledOn) || a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((s) => [
        s.id,
        groupOf.get(s.groupId) ?? s.groupId,
        s.settledOn,
        who(s.fromUserId),
        who(s.toUserId),
        formatMinor(s.amountMinor, s.currency),
        s.currency,
        s.amountMinor,
        formatMinor(s.billedAmountMinor, s.billedCurrency),
        s.billedCurrency,
        s.rate,
        s.rateCurrency,
        s.pricedRate,
        s.pricedRateCurrency,
        s.pricedSource,
        s.note,
        who(s.createdBy),
        s.createdAt,
        s.deletedAt,
        who(s.deletedBy),
      ]),
  );

  const budgets = file(
    "budgets.csv",
    ["group", "day", "amount_sgd", "amount_minor", "set_by", "updated_at"],
    data.budgets.map((b) => [
      groupOf.get(b.groupId) ?? b.groupId,
      b.day,
      formatMinor(b.amountMinor, "SGD"),
      b.amountMinor,
      who(b.setBy),
      b.updatedAt,
    ]),
  );

  const dailyRates = file(
    "daily_rates.csv",
    ["group", "rate_date", "base", "quote", "rate", "set_by", "updated_at"],
    data.dailyRates.map((r) => [
      groupOf.get(r.groupId) ?? r.groupId,
      r.rateDate,
      r.base,
      r.quote,
      r.rate,
      who(r.setBy),
      r.updatedAt,
    ]),
  );

  const fxRates = file(
    "fx_rates.csv",
    ["rate_date", "base", "quote", "rate", "source_date", "provider", "fetched_at"],
    data.fxRates.map((r) => [
      r.rateDate,
      r.base,
      r.quote,
      r.rate,
      r.sourceDate,
      r.provider,
      r.fetchedAt,
    ]),
  );

  const auditLog = file(
    "audit_log.csv",
    ["id", "group", "actor", "action", "entity_type", "entity_id", "before", "after", "created_at"],
    data.auditLog.map((a) => [
      a.id,
      a.groupId === null ? "" : (groupOf.get(a.groupId) ?? a.groupId),
      who(a.actorUserId) || "system",
      a.action,
      a.entityType,
      a.entityId,
      json(a.before),
      json(a.after),
      a.createdAt,
    ]),
  );

  return [
    groups,
    members,
    expenses,
    describedParts("expense_payers.csv", data.expensePayers, false),
    describedParts("expense_shares.csv", data.expenseShares, true),
    settlements,
    budgets,
    dailyRates,
    fxRates,
    auditLog,
  ];
}
