import { type Locator, type Page } from "@playwright/test";
import { todayIn } from "@/lib/ledger";
import { expect, ledgerTest as test } from "./fixtures";
import { addExpense, expectNoSidewaysScroll, readBalances } from "./support/ledger-page";
import { resetLedgerData } from "./support/database";

// Seeded exchange rates (src/db/seed.ts): S$1.50 per EUR and S$1.60 per CHF on every trip day.
// Everything below is dated in the past (the trip is 2 to 5 Nov 2026), so "so far" means the whole trip.

test.beforeEach(async () => {
  await resetLedgerData();
});

/** "S$1,102.74" or "-S$5.00" as integer cents. */
function cents(text: string): number {
  const match = /^(-?)S\$([\d,]+)\.(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`Not an SGD amount: "${text}"`);
  const value = Number(match[2]?.replace(/,/g, "")) * 100 + Number(match[3]);
  return match[1] === "-" ? -value : value;
}

async function textOf(locator: Locator): Promise<string> {
  return (await locator.innerText()).trim();
}

async function sumOf(locator: Locator): Promise<number> {
  let total = 0;
  for (const item of await locator.all()) total += cents(await textOf(item));
  return total;
}

function dayRow(page: Page, day: string): Locator {
  return page.locator(`[data-testid="day-row"][data-day="${day}"]`);
}

async function setDailyBudget(page: Page, amount: string): Promise<void> {
  await page.goto("/budget");
  await page.getByLabel("Budget per day (SGD)").fill(amount);
  await page.getByRole("button", { name: "Save daily budget" }).click();
  await expect(page.getByRole("status")).toHaveText("Daily budget saved.");
}

async function setTrip(page: Page, first: string, last: string): Promise<void> {
  await page.goto("/budget");
  await page.getByLabel("First day").fill(first);
  await page.getByLabel("Last day").fill(last);
  await page.getByRole("button", { name: "Save trip" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Trip saved" })).toBeVisible();
}

/** Three days of spending with a known total: S$150.00, S$862.74 and S$250.00. */
async function addTripExpenses(page: Page): Promise<void> {
  await addExpense(page, {
    description: "Lunch",
    amount: "100.00",
    currency: "EUR",
    date: "2026-11-02",
    category: "Food",
  });
  await addExpense(page, {
    description: "Dinner at Trattoria Roma",
    amount: "148.49",
    currency: "EUR",
    date: "2026-11-03",
    category: "Food",
  });
  await addExpense(page, {
    description: "Hotel Lumiere",
    amount: "424.80",
    currency: "EUR",
    date: "2026-11-03",
    category: "Stay",
    billed: { amount: "640.00", currency: "SGD" },
  });
  await addExpense(page, {
    description: "Train",
    amount: "250.00",
    currency: "SGD",
    date: "2026-11-04",
    category: "Transport",
  });
}

test.describe("the dashboard totals match the ledger", () => {
  test("day, person, category and trip totals add up to the expense list", async ({ page }) => {
    await addTripExpenses(page);

    await page.goto("/expenses");
    const ledgerTotal = cents(await textOf(page.getByTestId("group-total")));
    expect(ledgerTotal).toBe(15000 + 86274 + 25000);

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    // Each day, exactly as the ledger prices it: the euros at S$1.50, the hotel at its billed S$640.00.
    await expect(dayRow(page, "2026-11-02").getByTestId("day-spent")).toHaveText("S$150.00");
    await expect(dayRow(page, "2026-11-03").getByTestId("day-spent")).toHaveText("S$862.74");
    await expect(dayRow(page, "2026-11-04").getByTestId("day-spent")).toHaveText("S$250.00");

    // The trip total, the days, the people and the categories all agree with the ledger.
    await expect(page.getByTestId("trip-total")).toHaveText("S$1,262.74");
    expect(cents(await textOf(page.getByTestId("trip-total")))).toBe(ledgerTotal);
    expect(await sumOf(page.getByTestId("day-spent"))).toBe(ledgerTotal);
    await expect(page.getByTestId("person-row")).toHaveCount(4);
    expect(await sumOf(page.getByTestId("category-amount"))).toBe(ledgerTotal);

    // The people table shows each member's share (not who paid): their trip totals add up too.
    const shares = await page
      .getByTestId("person-row")
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelector('[data-testid="person-spent"]')?.textContent ?? ""),
      );
    const soFar = await textOf(page.getByTestId("spent-so-far"));
    expect(shares.reduce((sum, share) => sum + cents(share), 0)).toBe(cents(soFar));
    expect(cents(soFar)).toBe(ledgerTotal);

    // Categories: Food (S$150.00 + S$222.74), Stay (S$640.00), Transport (S$250.00).
    await expect(page.locator('[data-category="food"] [data-testid="category-amount"]')).toHaveText(
      "S$372.74",
    );
    await expect(page.locator('[data-category="stay"] [data-testid="category-amount"]')).toHaveText(
      "S$640.00",
    );
    await expect(
      page.locator('[data-category="transport"] [data-testid="category-amount"]'),
    ).toHaveText("S$250.00");
    await expectNoSidewaysScroll(page);
  });

  test("a day opens to the expenses on it, with the same totals", async ({ page }) => {
    await addTripExpenses(page);
    await page.goto("/dashboard");
    await dayRow(page, "2026-11-03").click();
    await expect(page).toHaveURL(/\/dashboard\/2026-11-03$/);

    await expect(page.getByTestId("day-total")).toHaveText("S$862.74");
    await expect(page.getByTestId("day-expense-count")).toHaveText("2");
    const expenses = page.getByTestId("day-expenses");
    await expect(expenses).toContainText("Dinner at Trattoria Roma");
    await expect(expenses).toContainText("Hotel Lumiere");
    await expect(expenses).toContainText("S$222.74");
    await expect(expenses).toContainText("S$640.00");

    // Each person's share of the day adds up to the day total, and so do the categories.
    expect(await sumOf(page.getByTestId("person-spent"))).toBe(86274);
    expect(await sumOf(page.getByTestId("category-amount"))).toBe(86274);

    // Neighbouring days are one tap away, and an expense opens its own page.
    await page.getByRole("link", { name: /Wed 4 Nov/ }).click();
    await expect(page.getByTestId("day-total")).toHaveText("S$250.00");
    await page.getByRole("link", { name: /Train/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Train" })).toBeVisible();
  });

  test("filters to one person's share", async ({ page }) => {
    await addExpense(page, {
      description: "Gelato for two",
      amount: "10.00",
      currency: "SGD",
      date: "2026-11-02",
      excluded: ["Mum", "Dad"],
    });
    await addExpense(page, {
      description: "Museum",
      amount: "40.00",
      currency: "SGD",
      date: "2026-11-02",
    });
    await page.goto("/dashboard");
    await expect(dayRow(page, "2026-11-02").getByTestId("day-spent")).toHaveText("S$50.00");

    await page.getByRole("link", { name: "Mum", exact: true }).click();
    await expect(page).toHaveURL(/person=/);
    await expect(page.getByText("Mum's share so far")).toBeVisible();
    // Mum shares only the museum: S$10.00 of S$40.00.
    await expect(dayRow(page, "2026-11-02").getByTestId("day-spent")).toHaveText("S$10.00");
    await page.getByRole("link", { name: "Jamie", exact: true }).click();
    // Jamie shares both: S$5.00 of the gelato and S$10.00 of the museum.
    await expect(dayRow(page, "2026-11-02").getByTestId("day-spent")).toHaveText("S$15.00");
  });
});

test.describe("the daily budget", () => {
  test("the meter shows under, near and over, for the group and for each person", async ({
    page,
  }) => {
    await addTripExpenses(page); // S$150.00, S$862.74 and S$250.00
    await addExpense(page, {
      description: "Solo snack",
      amount: "100.00",
      currency: "SGD",
      date: "2026-11-05",
      excluded: ["Jamie", "Mum", "Dad"],
    });
    await setTrip(page, "2026-11-02", "2026-11-05");
    await setDailyBudget(page, "300");

    await page.goto("/dashboard");
    const meterOf = (day: string) => dayRow(page, day).getByTestId("budget-meter");
    const stateOf = (day: string) => dayRow(page, day).getByTestId("budget-state");

    // 150 of 300 is 50%: under. 862.74 of 300: over. 250 of 300 is 83%: near. 100 of 300: under.
    await expect(meterOf("2026-11-02")).toHaveAttribute("data-state", "under");
    await expect(meterOf("2026-11-03")).toHaveAttribute("data-state", "over");
    await expect(meterOf("2026-11-04")).toHaveAttribute("data-state", "near");
    await expect(meterOf("2026-11-05")).toHaveAttribute("data-state", "under");
    // The state is also in words, so colour is never the only signal.
    await expect(stateOf("2026-11-02")).toHaveText("Under");
    await expect(stateOf("2026-11-03")).toHaveText("Over");
    await expect(stateOf("2026-11-04")).toHaveText("Near");
    await expect(meterOf("2026-11-03")).toHaveAttribute(
      "aria-valuetext",
      "S$862.74 of S$300.00, over budget",
    );

    // Trip so far: S$1,362.74 of 4 days x S$300.00; one day over.
    await expect(page.getByTestId("spent-so-far")).toHaveText("S$1,362.74");
    await expect(page.getByTestId("summary")).toContainText("of S$1,200.00 budget over 4 days");
    await expect(page.getByTestId("remaining")).toHaveText("S$162.74 over budget");
    await expect(page.getByTestId("days-over")).toHaveText("1");
    await expect(page.getByTestId("summary").getByTestId("budget-state").first()).toHaveText(
      "Over",
    );

    // Per person: the 5th is under for the group, but Alex alone spent S$100.00 against a S$75.00 share.
    await page.goto("/dashboard/2026-11-05");
    await expect(page.getByTestId("day-summary").getByTestId("budget-state")).toHaveText("Under");
    const alex = page.locator('[data-testid="person-row"][data-member="Alex"]');
    await expect(alex.getByTestId("person-spent")).toHaveText("S$100.00");
    await expect(alex).toContainText("of S$75.00");
    await expect(alex.getByTestId("budget-meter")).toHaveAttribute("data-state", "over");
    await expect(
      page.locator('[data-testid="person-row"][data-member="Mum"]').getByTestId("budget-meter"),
    ).toHaveAttribute("data-state", "under");
  });

  test("a budget for a single day overrides the default and can be removed", async ({ page }) => {
    await addTripExpenses(page);
    await setTrip(page, "2026-11-02", "2026-11-05");
    await setDailyBudget(page, "300");

    await page.getByLabel("Day", { exact: true }).fill("2026-11-03");
    await page.getByLabel("Budget for that day (SGD)").fill("900");
    await page.getByRole("button", { name: "Set budget for this day" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Budget for that day saved" }),
    ).toBeVisible();
    await expect(page.getByTestId("day-budget")).toHaveCount(1);
    await expect(page.getByTestId("day-budget")).toContainText("S$900.00");

    await page.goto("/dashboard");
    // 862.74 of 900.00 is 95%: near, no longer over.
    await expect(dayRow(page, "2026-11-03").getByTestId("budget-state")).toHaveText("Near");
    await expect(dayRow(page, "2026-11-03")).toContainText("of S$900.00");
    await expect(dayRow(page, "2026-11-02")).toContainText("of S$300.00");
    await expect(page.getByTestId("days-over")).toHaveText("0");
    await expect(page.getByTestId("summary")).toContainText("of S$1,800.00 budget over 4 days");

    await page.goto("/dashboard/2026-11-03");
    await expect(page.getByTestId("day-summary")).toContainText("A budget set for this day");

    await page.goto("/budget");
    await page.getByRole("button", { name: /Remove the budget for/ }).click();
    await expect(page.getByTestId("day-budget")).toHaveCount(0);
    await page.goto("/dashboard");
    await expect(dayRow(page, "2026-11-03").getByTestId("budget-state")).toHaveText("Over");
  });

  test("shows today's spending against today's budget, in the trip's time zone", async ({
    page,
  }) => {
    const today = todayIn(new Date(), "Europe/Zurich");
    await addExpense(page, {
      description: "Today's lunch",
      amount: "270.00",
      currency: "SGD",
      date: today,
    });
    await setDailyBudget(page, "300");
    await page.goto("/dashboard");
    await expect(page.getByTestId("today-spent")).toHaveText("S$270.00");
    await expect(page.getByTestId("summary")).toContainText("of S$300.00");
    await expect(dayRow(page, today)).toContainText("Today");
    await expect(dayRow(page, today).getByTestId("budget-state")).toHaveText("Near"); // 90%
  });

  test("asks for a budget when none is set, and says what is missing", async ({ page }) => {
    await addTripExpenses(page);
    await page.goto("/dashboard");
    await expect(page.getByText("No daily budget yet.")).toBeVisible();
    await expect(page.getByTestId("budget-meter")).toHaveCount(0);
    await page.getByRole("link", { name: "Set one" }).click();
    await expect(page).toHaveURL(/\/budget$/);
  });

  test("explains a mistake instead of saving it", async ({ page }) => {
    await page.goto("/budget");
    await page.getByLabel("Budget per day (SGD)").fill("abc");
    await page.getByRole("button", { name: "Save daily budget" }).click();
    await expect(page.getByText("Type just the number, e.g. 48.50")).toBeVisible();
    await expect(page.getByLabel("Budget per day (SGD)")).toHaveValue("abc");
    await page.getByLabel("Day", { exact: true }).fill("2026-11-04");
    await page.getByLabel("Budget for that day (SGD)").fill("lots");
    await page.getByRole("button", { name: "Set budget for this day" }).click();
    await expect(page.getByLabel("Budget for that day (SGD)")).toHaveValue("lots");
    await expect(page.getByLabel("Day", { exact: true })).toHaveValue("2026-11-04");
    await page.getByLabel("Last day").fill("2026-11-01");
    await page.getByLabel("First day").fill("2026-11-09");
    await page.getByRole("button", { name: "Save trip" }).click();
    await expect(page.getByText("The trip cannot end before it starts")).toBeVisible();
    await expect(page.getByLabel("Last day")).toHaveValue("2026-11-01");
    await expect(page.getByLabel("First day")).toHaveValue("2026-11-09");
  });
});

test.describe("daily exchange rates", () => {
  test("saving a day's rate moves nothing until the day is re-priced, and re-pricing is kept in the expense history", async ({
    page,
  }) => {
    await addTripExpenses(page);

    /** Every figure that depends on prices: balances, the dashboard's days and the group total. */
    async function shown() {
      await page.goto("/balances");
      const balances = await page.getByTestId("balance-amount").allInnerTexts();
      await page.goto("/dashboard");
      const days = {
        first: await textOf(dayRow(page, "2026-11-02").getByTestId("day-spent")),
        second: await textOf(dayRow(page, "2026-11-03").getByTestId("day-spent")),
        third: await textOf(dayRow(page, "2026-11-04").getByTestId("day-spent")),
      };
      await page.goto("/expenses");
      return { balances, days, total: await textOf(page.getByTestId("group-total")) };
    }

    const before = await shown();
    expect(before.days).toEqual({ first: "S$150.00", second: "S$862.74", third: "S$250.00" });
    expect(before.total).toBe("S$1,262.74");

    await page.goto("/rates");
    const day = page.locator('[data-testid="rate-day"][data-day="2026-11-03"]');
    await expect(day.getByTestId("effective-rate")).toHaveText("1.5");
    await expect(day).toContainText("Market");

    await day.locator("summary").click();
    await day.getByLabel("SGD per 1 EUR").fill("1.6");
    await day.getByRole("button", { name: "Save rate" }).click();
    await expect(day.getByTestId("rate-result")).toContainText(
      "Rate saved. Existing expenses keep their figures.",
    );
    await expect(day.getByTestId("effective-rate")).toHaveText("1.6");
    await expect(day).toContainText("Your rate");

    // The new rate has not moved a single figure.
    expect(await shown()).toEqual(before);

    // The offer covers the dinner only: the hotel keeps the exact SGD figure the bank billed.
    await page.goto("/rates");
    await day.locator("summary").click();
    await day.getByRole("button", { name: "Re-price 1 expense on this day" }).click();
    await expect(day.getByTestId("rate-result")).toContainText("Re-priced 1 expense");
    await expect(day).toContainText("S$222.74 (Market rate S$1.5) to S$237.58 (Day rate S$1.6)");

    const repriced = await shown();
    expect(repriced.days).toEqual({ first: "S$150.00", second: "S$877.58", third: "S$250.00" });
    expect(repriced.total).toBe("S$1,277.58");
    expect(repriced.balances).not.toEqual(before.balances);

    await page.goto("/dashboard/2026-11-03");
    await page.getByRole("link", { name: /Dinner at Trattoria Roma/ }).click();
    await expect(page.getByTestId("sgd-amount")).toHaveText("S$237.58");
    await expect(page.getByTestId("conversion")).toHaveText("Day rate S$1.6 per EUR");
    await page.getByRole("link", { name: /History/ }).click();
    const reprice = page.getByTestId("history-entry").filter({ hasText: "Re-priced" });
    await expect(reprice).toHaveCount(1);
    await expect(reprice).toContainText("S$222.74 (Market rate S$1.5)");
    await expect(reprice).toContainText("S$237.58 (Day rate S$1.6)");
    await expect(reprice.getByTestId("history-actor")).toHaveText("Alex");

    // Removing the rate moves nothing either; re-pricing then goes back to the market rate.
    await page.goto("/rates");
    await day.locator("summary").click();
    await day.getByRole("button", { name: "Use the market rate" }).click();
    await expect(day.getByTestId("rate-result")).toContainText(
      "Rate removed. Existing expenses keep their figures.",
    );
    await expect(day.getByTestId("effective-rate")).toHaveText("1.5");
    expect(await shown()).toEqual(repriced);

    await page.goto("/rates");
    await day.locator("summary").click();
    await day.getByRole("button", { name: "Re-price 1 expense on this day" }).click();
    await expect(day.getByTestId("rate-result")).toContainText("Re-priced 1 expense");
    expect(await shown()).toEqual(before);

    // Re-pricing again has nothing to change, and says so.
    await page.goto("/rates");
    await day.locator("summary").click();
    await day.getByRole("button", { name: "Re-price 1 expense on this day" }).click();
    await expect(day.getByTestId("rate-result")).toContainText("Nothing needed re-pricing");
    await expectNoSidewaysScroll(page);
  });

  test("a day with only a settlement offers a re-price that moves just that settlement", async ({
    page,
  }) => {
    await page.goto("/settlements/new");
    await page.getByLabel("Paid by").selectOption({ label: "Mum" });
    await page.getByLabel("Paid to").selectOption({ label: "Alex" });
    await page.getByLabel("Amount", { exact: true }).fill("20.00");
    await page.getByLabel("Currency", { exact: true }).selectOption("EUR");
    await page.getByLabel("Date").fill("2026-11-05");
    await page.getByRole("button", { name: "Record settlement" }).click();
    await expect(page.getByTestId("settlement-row")).toContainText("S$30.00");
    const before = await readBalances(page);

    await page.goto("/rates");
    const day = page.locator('[data-testid="rate-day"][data-day="2026-11-05"]');
    await day.locator("summary").click();
    await day.getByLabel("SGD per 1 EUR").fill("1.6");
    await day.getByRole("button", { name: "Save rate" }).click();
    await expect(day.getByTestId("rate-result")).toContainText(
      "Rate saved. Existing expenses keep their figures.",
    );
    await expect(day.getByTestId("rate-result")).toContainText(
      "Re-pricing would change 1 of the 1 settlement on this day.",
    );

    // Saving the rate moved nothing.
    await page.goto("/balances");
    await expect(page.getByTestId("settlement-row")).toContainText("S$30.00");
    expect(await readBalances(page)).toEqual(before);

    await page.goto("/rates");
    await day.locator("summary").click();
    await day.getByRole("button", { name: "Re-price 1 settlement on this day" }).click();
    await expect(day.getByTestId("rate-result")).toContainText("Re-priced 1 settlement");
    await expect(day).toContainText(
      "Settlement of \u20ac20.00: S$30.00 (Market rate S$1.5) to S$32.00 (Day rate S$1.6)",
    );

    await page.goto("/balances");
    await expect(page.getByTestId("settlement-row")).toContainText("S$32.00");
    expect(await readBalances(page)).not.toEqual(before);

    await page.goto("/rates");
    await day.locator("summary").click();
    await day.getByRole("button", { name: "Re-price 1 settlement on this day" }).click();
    await expect(day.getByTestId("rate-result")).toContainText("Nothing needed re-pricing");
  });

  test("rejects a rate that is not a number and keeps the old figures", async ({ page }) => {
    await addTripExpenses(page);
    await page.goto("/rates");
    const day = page.locator('[data-testid="rate-day"][data-day="2026-11-03"]');
    await day.locator("summary").click();
    await day.getByLabel("SGD per 1 EUR").fill("zero");
    await day.getByRole("button", { name: "Save rate" }).click();
    await expect(day.getByText(/Enter a rate like 1\.5340/)).toBeVisible();
    await expect(day.getByLabel("SGD per 1 EUR")).toHaveValue("zero");
    await page.goto("/dashboard");
    await expect(dayRow(page, "2026-11-03").getByTestId("day-spent")).toHaveText("S$862.74");
  });

  test("offers each trip currency", async ({ page }) => {
    await page.goto("/rates");
    await expect(page.getByRole("link", { name: "EUR", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByRole("link", { name: "CHF", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Exchange rates");
    await expect(page.getByText(/SGD per 1 CHF/).first()).toBeVisible();
  });
});

test.describe("layout", () => {
  test("the dashboard pages fit the screen and reach every part of the plan", async ({
    page,
  }, info) => {
    await addTripExpenses(page);
    await setDailyBudget(page, "300");
    for (const path of ["/dashboard", "/dashboard/2026-11-03", "/budget", "/rates"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoSidewaysScroll(page);
    }

    await page.goto("/dashboard");
    await expect(page.getByTestId("day-chart")).toBeVisible();
    // One chart column per day, each leading to its day.
    await expect(page.locator('[data-testid="day-chart"] [data-day]').first()).toBeVisible();
    await expect(page.getByTestId("legend")).toContainText("Food");
    await expect(page.getByTestId("legend")).toContainText("Daily budget");

    const nav = page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Rates" }).click();
    await expect(page).toHaveURL(/\/rates/);

    // Touch targets on phones are at least 44px tall.
    if (info.project.name === "phone") {
      await page.goto("/dashboard");
      const row = await dayRow(page, "2026-11-03").boundingBox();
      expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
