import { describe, expect, it } from "vitest";
import { buildExportFiles, formatMinor, type ExportData } from "./ledger-csv";

const G = "g1";
const ALEX = "u-alex";
const MEI = "u-mei";
const at = new Date("2026-11-03T10:00:00Z");

const DATA: ExportData = {
  users: [
    { id: ALEX, displayName: "Alex" },
    { id: MEI, displayName: "Mei" },
  ],
  groups: [
    {
      id: G,
      name: "Switzerland and Italy",
      tripStart: "2026-11-02",
      tripEnd: null,
      timeZone: "Europe/Zurich",
    },
  ],
  memberships: [
    { groupId: G, userId: MEI, position: 1, isOwner: false },
    { groupId: G, userId: ALEX, position: 0, isOwner: true },
  ],
  telegramLinks: [{ userId: ALEX, telegramUserId: 1001, username: "alex" }],
  expenses: [
    {
      id: "e2",
      groupId: G,
      importId: null,
      spentOn: "2026-11-04",
      description: "=SUM(A1)",
      category: "food",
      amountMinor: 950,
      currency: "EUR",
      billedAmountMinor: null,
      billedCurrency: null,
      rate: null,
      rateCurrency: null,
      pricedRate: null,
      pricedRateCurrency: null,
      pricedSource: null,
      splitMethod: "equal",
      createdBy: MEI,
      createdAt: at,
      updatedAt: at,
      deletedAt: at,
      deletedBy: MEI,
    },
    {
      id: "e1",
      groupId: G,
      importId: "imp1",
      spentOn: "2026-11-03",
      description: "Dinner, Roma",
      category: "food",
      amountMinor: 14849,
      currency: "EUR",
      billedAmountMinor: 22000,
      billedCurrency: "SGD",
      rate: "1.5",
      rateCurrency: "EUR",
      pricedRate: "1.5",
      pricedRateCurrency: "EUR",
      pricedSource: "market",
      splitMethod: "equal",
      createdBy: ALEX,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedBy: null,
    },
  ],
  expensePayers: [{ expenseId: "e1", userId: ALEX, amountMinor: 14849 }],
  expenseShares: [
    { expenseId: "e1", userId: ALEX, amountMinor: 7425, weight: null },
    { expenseId: "e1", userId: MEI, amountMinor: 7424, weight: 1 },
  ],
  settlements: [
    {
      id: "s1",
      groupId: G,
      fromUserId: MEI,
      toUserId: ALEX,
      amountMinor: 3000,
      currency: "EUR",
      billedAmountMinor: null,
      billedCurrency: null,
      rate: null,
      rateCurrency: null,
      pricedRate: null,
      pricedRateCurrency: null,
      pricedSource: null,
      settledOn: "2026-11-05",
      note: "cash",
      createdBy: MEI,
      createdAt: at,
      deletedAt: null,
      deletedBy: null,
    },
  ],
  budgets: [{ groupId: G, day: null, amountMinor: 30000, setBy: ALEX, updatedAt: at }],
  dailyRates: [
    {
      groupId: G,
      rateDate: "2026-11-03",
      base: "EUR",
      quote: "SGD",
      rate: "1.51",
      setBy: ALEX,
      updatedAt: at,
    },
  ],
  fxRates: [
    {
      rateDate: "2026-11-03",
      base: "EUR",
      quote: "SGD",
      rate: "1.5",
      sourceDate: "2026-11-03",
      provider: "frankfurter",
      fetchedAt: at,
    },
  ],
  auditLog: [
    {
      id: 1,
      groupId: G,
      actorUserId: ALEX,
      action: "expense.create",
      entityType: "expense",
      entityId: "e1",
      before: null,
      after: { amount: 1 },
      createdAt: at,
    },
    {
      id: 2,
      groupId: null,
      actorUserId: null,
      action: "import.image_deleted",
      entityType: "import",
      entityId: null,
      before: null,
      after: null,
      createdAt: at,
    },
  ],
};

const lines = (content: string) => content.replace("﻿", "").trimEnd().split("\r\n");
const named = (name: string) => {
  const found = buildExportFiles(DATA).find((file) => file.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

describe("formatMinor", () => {
  it("shows minor units as decimals using the currency's exponent", () => {
    expect(formatMinor(14849, "EUR")).toBe("148.49");
    expect(formatMinor(5, "EUR")).toBe("0.05");
    expect(formatMinor(500, "JPY")).toBe("500");
    expect(formatMinor(-1250, "CHF")).toBe("-12.50");
    expect(formatMinor(1234, "XXX")).toBe("1234");
    expect(formatMinor(1234, null)).toBe("1234");
    expect(formatMinor(null, "EUR")).toBe("");
  });
});

describe("buildExportFiles", () => {
  it("writes one file per table with the row counts", () => {
    expect(buildExportFiles(DATA).map((file) => [file.name, file.rows])).toEqual([
      ["groups.csv", 1],
      ["members.csv", 2],
      ["expenses.csv", 2],
      ["expense_payers.csv", 1],
      ["expense_shares.csv", 2],
      ["settlements.csv", 1],
      ["budgets.csv", 1],
      ["daily_rates.csv", 1],
      ["fx_rates.csv", 1],
      ["audit_log.csv", 2],
    ]);
  });

  it("lists members in group order with their Telegram ids", () => {
    expect(lines(named("members.csv").content)).toEqual([
      "group,position,name,is_owner,telegram_user_id,telegram_username",
      "Switzerland and Italy,0,Alex,true,1001,alex",
      "Switzerland and Italy,1,Mei,false,,",
    ]);
  });

  it("lists expenses by day with names, decimals and exact minor units, deleted ones included", () => {
    const [header, first, second] = lines(named("expenses.csv").content);
    expect(header).toContain("amount,currency,amount_minor,billed_amount");
    expect(first).toContain(
      'e1,Switzerland and Italy,2026-11-03,"Dinner, Roma",food,148.49,EUR,14849,220.00,SGD,1.5,EUR',
    );
    expect(first).toContain("Alex 148.49,Alex 74.25; Mei 74.24,Alex,");
    expect(first).toContain(",imp1");
    expect(second).toContain("e2,Switzerland and Italy,2026-11-04,'=SUM(A1),food,9.50,EUR,950");
    expect(second).toContain("2026-11-03T10:00:00.000Z,Mei,");
  });

  it("writes payers and shares in the expense's currency, shares with their weight", () => {
    expect(lines(named("expense_payers.csv").content)).toEqual([
      "expense_id,member,amount,currency,amount_minor",
      "e1,Alex,148.49,EUR,14849",
    ]);
    expect(lines(named("expense_shares.csv").content)).toEqual([
      "expense_id,member,amount,currency,amount_minor,weight",
      "e1,Alex,74.25,EUR,7425,",
      "e1,Mei,74.24,EUR,7424,1",
    ]);
  });

  it("writes settlements, budgets and rates", () => {
    expect(lines(named("settlements.csv").content)[1]).toContain(
      "s1,Switzerland and Italy,2026-11-05,Mei,Alex,30.00,EUR,3000",
    );
    expect(lines(named("budgets.csv").content)[1]).toBe(
      "Switzerland and Italy,,300.00,30000,Alex,2026-11-03T10:00:00.000Z",
    );
    expect(lines(named("daily_rates.csv").content)[1]).toContain("EUR,SGD,1.51,Alex");
    expect(lines(named("fx_rates.csv").content)[1]).toContain("EUR,SGD,1.5,2026-11-03,frankfurter");
  });

  it("keeps the audit trail, naming the system when nobody acted", () => {
    const [, first, second] = lines(named("audit_log.csv").content);
    expect(first).toContain(
      '1,Switzerland and Italy,Alex,expense.create,expense,e1,,"{""amount"":1}"',
    );
    expect(second).toContain("2,,system,import.image_deleted,import,,,,");
  });

  it("falls back to the id when a name is unknown", () => {
    const data: ExportData = { ...DATA, users: [], groups: [] };
    const settlements = buildExportFiles(data).find((file) => file.name === "settlements.csv");
    expect(settlements?.content).toContain("s1,g1,2026-11-05,u-mei,u-alex");
  });
});
