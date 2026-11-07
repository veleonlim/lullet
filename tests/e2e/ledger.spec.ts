import { expect, test, type Page } from "@playwright/test";
import {
  addExpense,
  expectNoSidewaysScroll,
  fillExpenseForm,
  readBalances,
} from "./support/ledger-page";
import { resetLedgerData } from "./support/database";

// Seeded exchange rates (src/db/seed.ts): S$1.50 per EUR and S$1.60 per CHF on every trip day.

test.beforeEach(async () => {
  await resetLedgerData();
});

test.describe("adding an expense", () => {
  test("shows the native amount and the SGD figure in the list and on the detail page", async ({
    page,
  }) => {
    await page.goto("/expenses");
    await expect(page.getByText("No expenses yet")).toBeVisible();

    await addExpense(page, {
      description: "Dinner at Trattoria Roma",
      amount: "148.49",
      currency: "EUR",
      date: "2026-11-03",
      category: "Food",
    });
    await expect(page.getByTestId("native-amount")).toHaveText("€148.49");
    await expect(page.getByTestId("sgd-amount")).toHaveText("S$222.74");
    await expect(page.getByTestId("conversion")).toHaveText("Market rate S$1.5 per EUR");
    // The spare cent goes to the first member in the fixed order: 3713, 3712, 3712, 3712.
    const shared = page
      .getByRole("region", { name: /Shared between/ })
      .or(page.locator("section[aria-labelledby=split-between]"));
    await expect(shared).toContainText("Alex");
    await expect(shared).toContainText("€37.13");
    await expect(shared).toContainText("€37.12");

    await page.goto("/expenses");
    const day = page.getByRole("region", { name: "Tue 3 Nov" });
    await expect(day).toContainText("Dinner at Trattoria Roma");
    await expect(day).toContainText("€148.49");
    await expect(day).toContainText("S$222.74");
    await expect(page.getByTestId("group-total")).toHaveText("S$222.74");
    await expectNoSidewaysScroll(page);
  });

  test("groups the list by day, newest first", async ({ page }) => {
    await addExpense(page, { description: "Early", amount: "10", date: "2026-11-02" });
    await addExpense(page, { description: "Late", amount: "20", date: "2026-11-05" });
    await addExpense(page, { description: "Middle", amount: "30", date: "2026-11-03" });
    await page.goto("/expenses");
    const days = page.locator("main section[aria-label]");
    await expect(days).toHaveCount(3);
    await expect(days.nth(0)).toHaveAttribute("aria-label", "Thu 5 Nov");
    await expect(days.nth(1)).toHaveAttribute("aria-label", "Tue 3 Nov");
    await expect(days.nth(2)).toHaveAttribute("aria-label", "Mon 2 Nov");
  });

  test("counts a billed SGD figure exactly and uses a rate set on the expense", async ({
    page,
  }) => {
    await addExpense(page, {
      description: "Hotel",
      amount: "424.80",
      currency: "EUR",
      date: "2026-11-03",
      billed: { amount: "640.00", currency: "SGD" },
    });
    await expect(page.getByTestId("sgd-amount")).toHaveText("S$640.00");
    await expect(page.getByTestId("billed-amount")).toHaveText("S$640.00");
    await expect(page.getByTestId("conversion")).toHaveText(
      "Exact figure billed by your bank in SGD",
    );

    await addExpense(page, {
      description: "Souvenirs",
      amount: "100.00",
      currency: "CHF",
      date: "2026-11-03",
      rate: "1.75",
    });
    await expect(page.getByTestId("sgd-amount")).toHaveText("S$175.00");
    await expect(page.getByTestId("conversion")).toHaveText("Your rate S$1.75 per CHF");
  });

  test("converts the billed amount when the bank billed another currency", async ({ page }) => {
    await addExpense(page, {
      description: "Cable car",
      amount: "50.00",
      currency: "EUR",
      date: "2026-11-04",
      billed: { amount: "60.00", currency: "CHF" },
    });
    await expect(page.getByTestId("sgd-amount")).toHaveText("S$96.00");
    await expect(page.getByTestId("conversion")).toHaveText("Market rate S$1.6 per CHF");
  });

  test("validates before saving and explains what is wrong", async ({ page }) => {
    await page.goto("/expenses/new");
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("Add a description")).toBeVisible();
    await expect(page.getByText("Enter an amount", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/expenses\/new$/);
    await expect(page.getByLabel("Description")).toBeFocused();

    await page.getByLabel("Description").fill("Gelato");
    await page.getByLabel("Amount", { exact: true }).fill("1.234");
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByText(/Unclear amount/)).toBeVisible();
  });
});

test.describe("several payers", () => {
  test("payments must add up exactly, then the expense is saved with both payers", async ({
    page,
  }) => {
    await page.goto("/expenses/new");
    await fillExpenseForm(page, {
      description: "Restaurant",
      amount: "100.00",
      currency: "EUR",
      date: "2026-11-03",
      payers: [
        { name: "Alex", amount: "60.00" },
        { name: "Mum", amount: "39.99" },
      ],
    });
    await expect(page.getByText("€0.01 left to assign")).toBeVisible();
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(
      page.getByText("Payments add up to €99.99, but the expense is €100.00"),
    ).toBeVisible();

    await page.getByLabel("Mum paid").fill("40.00");
    await expect(page.getByText("Adds up to €100.00")).toBeVisible();
    await page.getByRole("button", { name: "Add expense" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Restaurant" })).toBeVisible();
    const paidBy = page.locator("section[aria-labelledby=paid-by]");
    await expect(paidBy).toContainText("Alex");
    await expect(paidBy).toContainText("€60.00");
    await expect(paidBy).toContainText("Mum");
    await expect(paidBy).toContainText("€40.00");
  });

  test("the balances count what each person actually paid", async ({ page }) => {
    await addExpense(page, {
      description: "Restaurant",
      amount: "100.00",
      currency: "EUR",
      date: "2026-11-03",
      payers: [
        { name: "Alex", amount: "60.00" },
        { name: "Mum", amount: "40.00" },
      ],
    });
    await page.goto("/balances");
    // S$150.00 shared four ways is S$37.50 each. Alex paid S$90, Mum S$60.
    expect(await readBalances(page)).toEqual({
      Alex: "+S$52.50",
      Jamie: "-S$37.50",
      Mum: "+S$22.50",
      Dad: "-S$37.50",
    });
  });
});

test.describe("split modes", () => {
  test("exact, percent and shares splits are saved as entered", async ({ page }) => {
    await page.goto("/expenses/new");
    await fillExpenseForm(page, {
      description: "Boat trip",
      amount: "90.00",
      currency: "CHF",
      date: "2026-11-04",
      excluded: ["Dad"],
    });
    await page.getByText("Shares", { exact: true }).click();
    await page.getByLabel("Alex shares", { exact: true }).fill("2");
    await expect(page.getByTestId("share-Alex")).toHaveText("CHF 45.00");
    await expect(page.getByTestId("share-Jamie")).toHaveText("CHF 22.50");

    await page.getByText("Percent", { exact: true }).click();
    await expect(page.getByLabel("Alex percent")).toHaveValue("33.34");
    await page.getByLabel("Alex percent").fill("50");
    await page.getByLabel("Jamie percent").fill("30");
    await page.getByLabel("Mum percent").fill("19");
    await expect(page.getByText("99% of 100% entered")).toBeVisible();
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByText("Percentages add up to 99.00%, not 100%")).toBeVisible();
    await page.getByLabel("Mum percent").fill("20");

    await page.getByText("Exact", { exact: true }).click();
    await expect(page.getByLabel("Alex amount")).toHaveValue("30.00");
    await page.getByLabel("Alex amount").fill("50.00");
    await page.getByLabel("Jamie amount").fill("25.00");
    // After a failed save the message follows the form live, so it names both totals.
    await expect(
      page.getByText(/Amounts add up to CHF.105\.00, but the expense is CHF.90\.00/),
    ).toBeVisible();
    await page.getByLabel("Mum amount").fill("15.00");
    await expect(page.getByText(/Adds up to CHF.90\.00/)).toBeVisible();
    await page.getByRole("button", { name: "Add expense" }).click();

    const shared = page.locator("section[aria-labelledby=split-between]");
    await expect(shared).toContainText("exact amounts");
    await expect(shared).toContainText("CHF 50.00");
    await expect(shared).toContainText("CHF 25.00");
    await expect(shared).toContainText("CHF 15.00");
    await expect(shared).not.toContainText("Dad");
  });

  test("an equal split can leave people out", async ({ page }) => {
    await addExpense(page, {
      description: "Colosseum",
      amount: "64.00",
      currency: "EUR",
      date: "2026-11-04",
      excluded: ["Jamie"],
    });
    const shared = page.locator("section[aria-labelledby=split-between]");
    await expect(shared).not.toContainText("Jamie");
    await expect(shared.getByText("€21.33")).toHaveCount(2);
    await page.goto("/expenses");
    await expect(page.getByText("3 of 4 share it")).toBeVisible();
  });
});

test.describe("editing", () => {
  test("changes the expense and records who changed what", async ({ page }) => {
    await addExpense(page, {
      description: "Trattoria",
      amount: "48.50",
      currency: "EUR",
      date: "2026-11-03",
    });
    await page.getByRole("link", { name: "Edit expense" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Edit expense" })).toBeVisible();
    await expect(page.getByLabel("Description")).toHaveValue("Trattoria");
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("48.50");

    await page.getByLabel("Description").fill("Trattoria Roma");
    await page.getByLabel("Amount", { exact: true }).fill("60.00");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Trattoria Roma" })).toBeVisible();
    await expect(page.getByTestId("native-amount")).toHaveText("€60.00");
    await expect(page.getByTestId("sgd-amount")).toHaveText("S$90.00");

    await page.getByRole("link", { name: /History/ }).click();
    const entries = page.getByTestId("history-entry");
    await expect(entries).toHaveCount(2);
    // Newest first: the edit, then the creation, both by the signed in member.
    await expect(entries.nth(0)).toContainText("Edited");
    await expect(entries.nth(0)).toContainText("Alex");
    await expect(entries.nth(0)).toContainText("Description");
    await expect(entries.nth(0)).toContainText("Trattoria");
    await expect(entries.nth(0)).toContainText("Trattoria Roma");
    await expect(entries.nth(0)).toContainText("€48.50");
    await expect(entries.nth(0)).toContainText("€60.00");
    await expect(entries.nth(1)).toContainText("Added");
    await expect(entries.nth(1)).toContainText("Alex");
    await expectNoSidewaysScroll(page);
  });

  test("keeps multi-payer and unequal splits when reopened", async ({ page }) => {
    await addExpense(page, {
      description: "Dinner",
      amount: "100.00",
      currency: "EUR",
      date: "2026-11-03",
      payers: [
        { name: "Jamie", amount: "70.00" },
        { name: "Dad", amount: "30.00" },
      ],
    });
    await page.getByRole("link", { name: "Edit expense" }).click();
    const paidBy = page.getByRole("group", { name: "Paid by" });
    await expect(paidBy.getByRole("checkbox", { name: "Jamie" })).toBeChecked();
    await expect(paidBy.getByRole("checkbox", { name: "Dad" })).toBeChecked();
    await expect(paidBy.getByRole("checkbox", { name: "Alex" })).not.toBeChecked();
    await expect(paidBy.getByLabel("Jamie paid")).toHaveValue("70.00");
    await expect(paidBy.getByLabel("Dad paid")).toHaveValue("30.00");
  });

  test("refuses an edit made from an out of date copy", async ({ browser, page }) => {
    await addExpense(page, { description: "Lunch", amount: "20.00", date: "2026-11-03" });
    await page.getByRole("link", { name: "Edit expense" }).click();
    await page.getByLabel("Description").fill("Lunch (mine)");

    // Someone else edits the same expense in the meantime.
    const other = await browser.newPage({ baseURL: page.url().split("/expenses")[0] });
    await other.goto(page.url());
    await other.getByLabel("Description").fill("Lunch (theirs)");
    await other.getByRole("button", { name: "Save changes" }).click();
    await expect(other.getByRole("heading", { level: 1, name: "Lunch (theirs)" })).toBeVisible();
    await other.close();

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByText("Someone else changed this expense while you were editing it."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/edit$/);
  });
});

test.describe("deleting", () => {
  test("soft deletes with an undo, lists it under Deleted, restores it, and logs every step", async ({
    page,
  }) => {
    await addExpense(page, {
      description: "Taxi",
      amount: "30.00",
      currency: "EUR",
      date: "2026-11-03",
    });
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page).toHaveURL(/\/expenses\?removed=/);
    await expect(page.getByRole("status")).toContainText("Deleted Taxi");
    await expect(page.getByText("No expenses yet")).toBeVisible();
    await expect(page.getByTestId("group-total")).toHaveText("S$0.00");

    await page.getByRole("link", { name: /^Deleted/ }).click();
    await expect(page.getByRole("link", { name: /Taxi/ })).toBeVisible();
    await page.getByRole("link", { name: /Taxi/ }).click();
    await expect(page.getByText("It does not count towards balances.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit expense" })).toHaveCount(0);

    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("It does not count towards balances.")).toHaveCount(0);
    await page.goto("/expenses");
    await expect(page.getByRole("link", { name: /Taxi/ })).toBeVisible();
    await expect(page.getByTestId("group-total")).toHaveText("S$45.00");

    await page.getByRole("link", { name: /Taxi/ }).click();
    await page.getByRole("link", { name: /History/ }).click();
    const entries = page.getByTestId("history-entry");
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText("Restored");
    await expect(entries.nth(1)).toContainText("Deleted");
    await expect(entries.nth(2)).toContainText("Added");
  });

  test("the undo link on the list brings the expense back", async ({ page }) => {
    await addExpense(page, { description: "Museum", amount: "12.00", date: "2026-11-03" });
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Museum" })).toBeVisible();
  });
});

test.describe("balances and settling up", () => {
  async function twoExpenses(page: Page) {
    // Alex pays EUR 100 (S$150.00); Jamie pays CHF 80 (S$128.00); both shared four ways.
    await addExpense(page, {
      description: "Dinner",
      amount: "100.00",
      currency: "EUR",
      date: "2026-11-03",
    });
    await addExpense(page, {
      description: "Train",
      amount: "80.00",
      currency: "CHF",
      date: "2026-11-04",
      payers: [{ name: "Jamie" }],
    });
  }

  test("shows net balances in SGD that match the ledger and sum to zero", async ({ page }) => {
    await twoExpenses(page);
    await page.goto("/balances");
    // Alex: +150 - 37.50 - 32 = +80.50 ... see the helper comment for the arithmetic.
    const balances = await readBalances(page);
    expect(balances).toEqual({
      Alex: "+S$80.50",
      Jamie: "+S$58.50",
      Mum: "-S$69.50",
      Dad: "-S$69.50",
    });
    const cents = Object.values(balances).map((text) =>
      Math.round(Number(text.replace(/[+S$]/g, "").replace("-", "-")) * 100),
    );
    expect(cents.reduce((a, b) => a + b, 0)).toBe(0);

    await page.goto("/expenses");
    await expect(page.getByTestId("group-total")).toHaveText("S$278.00");
    await expect(page.getByTestId("my-balance")).toHaveText("You are owed S$80.50");
  });

  test("suggests the fewest payments and records a settlement that moves the balances", async ({
    page,
  }) => {
    await twoExpenses(page);
    await page.goto("/balances");

    const transfers = page.getByTestId("transfer");
    await expect(transfers).toHaveCount(3);
    await expect(
      page.getByText("3 payments settle everything, the fewest possible."),
    ).toBeVisible();
    const amounts = await transfers.locator(".num").allInnerTexts();
    const total = amounts.reduce(
      (sum, text) => sum + Math.round(Number(text.replace("S$", "")) * 100),
      0,
    );
    expect(total).toBe(13900);

    await page.getByRole("link", { name: "Record Mum paying Alex" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Record settlement" })).toBeVisible();
    await expect(page.getByLabel("Paid by")).toHaveValue(/.+/);
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("69.50");
    await page.getByLabel("Note (optional)").fill("Cash at the hotel");
    await page.getByRole("button", { name: "Record settlement" }).click();

    await expect(page).toHaveURL(/\/balances\?settled=1/);
    await expect(page.getByRole("status")).toContainText("Settlement recorded.");
    expect(await readBalances(page)).toEqual({
      Alex: "+S$11.00",
      Jamie: "+S$58.50",
      Mum: "S$0.00",
      Dad: "-S$69.50",
    });
    await expect(page.getByTestId("transfer")).toHaveCount(2);
    const row = page.getByTestId("settlement-row");
    await expect(row).toContainText("Mum paid Alex");
    await expect(row).toContainText("Cash at the hotel");
    await expect(row).toContainText("S$69.50");
    await expectNoSidewaysScroll(page);
  });

  test("everyone is settled up once every suggested payment is recorded", async ({ page }) => {
    await twoExpenses(page);
    for (let i = 0; i < 3; i += 1) {
      await page.goto("/balances");
      await page
        .getByTestId("transfer")
        .first()
        .getByRole("link", { name: /^Record/ })
        .click();
      await page.getByRole("button", { name: "Record settlement" }).click();
      await expect(page).toHaveURL(/settled=1/);
    }
    await expect(page.getByText("Everyone is settled up")).toBeVisible();
    for (const text of Object.values(await readBalances(page))) expect(text).toBe("S$0.00");
  });

  test("a settlement in another currency is converted, and can be deleted and restored", async ({
    page,
  }) => {
    await twoExpenses(page);
    await page.goto("/settlements/new");
    await page.getByLabel("Paid by").selectOption({ label: "Mum" });
    await page.getByLabel("Paid to").selectOption({ label: "Alex" });
    await page.getByLabel("Amount", { exact: true }).fill("20.00");
    await page.getByLabel("Currency", { exact: true }).selectOption("EUR");
    await page.getByLabel("Date").fill("2026-11-05");
    await page.getByRole("button", { name: "Record settlement" }).click();

    const row = page.getByTestId("settlement-row");
    await expect(row).toContainText("€20.00");
    await expect(row).toContainText("S$30.00");
    expect((await readBalances(page)).Mum).toBe("-S$39.50");

    await row.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("status")).toContainText("Deleted the settlement");
    expect((await readBalances(page)).Mum).toBe("-S$69.50");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
    expect((await readBalances(page)).Mum).toBe("-S$39.50");
  });

  test("rejects a settlement from someone to themselves", async ({ page }) => {
    await page.goto("/settlements/new");
    await page.getByLabel("Paid by").selectOption({ label: "Mum" });
    await page.getByLabel("Paid to").selectOption({ label: "Mum" });
    await page.getByLabel("Amount", { exact: true }).fill("5");
    await page.getByRole("button", { name: "Record settlement" }).click();
    await expect(page.getByText("Pick two different people")).toBeVisible();
  });

  test("the balances page is empty and calm before any expense", async ({ page }) => {
    await page.goto("/balances");
    await expect(page.getByText("Everyone is settled up")).toBeVisible();
    for (const text of Object.values(await readBalances(page))) expect(text).toBe("S$0.00");
  });
});

test.describe("navigation", () => {
  test("moves between the pages with the tab bar or the header", async ({ page, isMobile }) => {
    await page.goto("/expenses");
    await page
      .getByRole("navigation", { name: "Main" })
      .filter({ visible: true })
      .getByRole("link", { name: "Balances" })
      .click();
    await expect(page).toHaveURL(/\/balances$/);
    await page
      .getByRole("navigation", { name: "Main" })
      .filter({ visible: true })
      .getByRole("link", { name: "Expenses" })
      .click();
    await expect(page).toHaveURL(/\/expenses$/);
    await page
      .getByRole("navigation", { name: "Main" })
      .filter({ visible: true })
      .getByRole("link", { name: "Add expense" })
      .click();
    await expect(page).toHaveURL(/\/expenses\/new$/);
    // The tab bar is for phones only; the header carries the links on wide screens.
    const tabBar = page.locator('nav[aria-label="Main"]').last();
    if (isMobile) await expect(tabBar).toBeVisible();
    else await expect(tabBar).toBeHidden();
  });

  test("an unknown expense is a 404", async ({ page }) => {
    const response = await page.goto("/expenses/00000000-0000-4000-8000-000000000000");
    expect(response?.status()).toBe(404);
    expect((await page.goto("/expenses/not-an-id"))?.status()).toBe(404);
    expect((await page.goto("/expenses/not-an-id/history"))?.status()).toBe(404);
  });
});

test.describe("every page", () => {
  test("loads without console errors, failed requests or sideways scrolling", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()}`));

    await addExpense(page, { description: "Check", amount: "10.00", date: "2026-11-03" });
    const detail = page.url();
    for (const url of [
      "/expenses",
      "/expenses?view=deleted",
      "/expenses/new",
      detail,
      `${detail}/edit`,
      `${detail}/history`,
      "/balances",
      "/settlements/new",
    ]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await expectNoSidewaysScroll(page);
    }
    expect(problems).toEqual([]);
  });
});
