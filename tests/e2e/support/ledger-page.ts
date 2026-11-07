import { expect, type Page } from "@playwright/test";

export interface PayerInput {
  readonly name: string;
  readonly amount?: string;
}

export interface ExpenseInput {
  readonly description: string;
  readonly amount: string;
  readonly currency?: string;
  readonly date?: string;
  readonly category?: string;
  readonly payers?: readonly PayerInput[];
  /** Members who do NOT share the expense (equal split). */
  readonly excluded?: readonly string[];
  readonly billed?: { amount: string; currency: string };
  readonly rate?: string;
}

/** Fills the add expense form the way a person would; does not submit. */
export async function fillExpenseForm(page: Page, input: ExpenseInput): Promise<void> {
  await page.getByLabel("Description").fill(input.description);
  if (input.category) await page.getByText(input.category, { exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill(input.amount);
  if (input.currency)
    await page.getByLabel("Currency", { exact: true }).selectOption(input.currency);
  if (input.date) await page.getByLabel("Date").fill(input.date);

  if (input.billed) {
    await page.getByRole("button", { name: "+ Billed amount" }).click();
    await page.getByLabel("Billed amount").fill(input.billed.amount);
    await page.getByLabel("Billed in").selectOption(input.billed.currency);
  }
  if (input.rate) {
    await page.getByRole("button", { name: "+ My own rate" }).click();
    await page.getByLabel(/^SGD per 1/).fill(input.rate);
  }

  if (input.payers) {
    const paidBy = page.getByRole("group", { name: "Paid by" });
    // Start from "nobody", then tick the payers: the first tick keeps one payer, so untick Alex last.
    for (const payer of input.payers) {
      const box = paidBy.getByRole("checkbox", { name: payer.name });
      if (!(await box.isChecked())) await box.check();
    }
    if (!input.payers.some((payer) => payer.name === "Alex")) {
      await paidBy.getByRole("checkbox", { name: "Alex" }).uncheck();
    }
    if (input.payers.length > 1) {
      for (const payer of input.payers) {
        await paidBy.getByLabel(`${payer.name} paid`).fill(payer.amount ?? "");
      }
    }
  }
  for (const name of input.excluded ?? []) {
    await page.getByRole("checkbox", { name: `${name} shares this` }).uncheck();
  }
}

export async function addExpense(page: Page, input: ExpenseInput): Promise<void> {
  await page.goto("/expenses/new");
  await fillExpenseForm(page, input);
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { level: 1, name: input.description })).toBeVisible();
}

/** The text of each member's net balance on the balances page, keyed by name. */
export async function readBalances(page: Page): Promise<Record<string, string>> {
  const rows = page.getByTestId("balance-row");
  await expect(rows).toHaveCount(4);
  const result: Record<string, string> = {};
  for (const row of await rows.all()) {
    const name = (await row.locator("p").first().innerText()).replace(/\s*You\s*$/, "").trim();
    result[name] = (await row.getByTestId("balance-amount").innerText()).trim();
  }
  return result;
}

export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
}
