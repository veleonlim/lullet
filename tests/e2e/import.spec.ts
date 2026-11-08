import { type Page } from "@playwright/test";
import { SEED_MEMBERS } from "@/db/seed-ids";
import { extraction, transaction, wireframeExtraction } from "@/test-support/extraction";
import { expect, ledgerTest as test } from "./fixtures";
import { signedInContext } from "./support/auth";
import { resetLedgerData } from "./support/database";
import { expectNoSidewaysScroll } from "./support/ledger-page";
import {
  personTotal,
  resetStubs,
  rowFor,
  screenshot,
  stubRead,
  uploadAndReview,
} from "./support/imports";

const [, jamie] = SEED_MEMBERS;

test.beforeEach(async () => {
  await resetLedgerData();
  await resetStubs();
});

async function expenseCount(page: Page): Promise<string> {
  await page.goto("/expenses");
  return (
    await page
      .getByText(/^\d+ expenses?$|^No expenses yet$/)
      .first()
      .innerText()
  ).trim();
}

test.describe("screenshot import", () => {
  test("upload, remove Jamie from one row, confirm and undo", async ({ page }) => {
    const image = screenshot(1);
    await stubRead(image, wireframeExtraction());

    // The way in from the expenses page.
    await page.goto("/expenses");
    await page.getByRole("link", { name: /import (a )?screenshot/i }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Import a screenshot" }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);

    const id = await uploadAndReview(page, image);
    await expect(page.getByRole("heading", { level: 1, name: "Review import" })).toBeVisible();
    await expect(page.getByTestId("import-row")).toHaveCount(4);
    await expect(page.getByText("Read by Claude Haiku 5.5")).toBeVisible();

    // The screenshot is shown beside the amounts (it is kept in the database during the review).
    await page.getByText("Original screenshot").click();
    const shown = page.getByRole("img", { name: "The uploaded screenshot" });
    await expect(shown).toBeVisible();
    await expect
      .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    // Step 3: Alex is the payer and the rest share equally; Alex's own share is off.
    const paidBy = page.getByRole("group", { name: "Paid by" });
    await expect(paidBy.getByRole("button", { name: "Alex" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(paidBy.getByRole("button", { name: "Jamie" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(personTotal(page, "Alex")).toContainText("Owes nothing");
    await expect(personTotal(page, "Alex")).toContainText("Paid €148.49");
    await expect(page.getByTestId("sum-check")).toHaveAttribute("data-matches", "true");

    // The AMZN row is a "check"; the others are clear.
    await expect(rowFor(page, "AMZN Mktp").getByText("Check", { exact: true })).toBeVisible();
    await expect(rowFor(page, "Trattoria Roma").getByText("Check", { exact: true })).toHaveCount(0);

    // Step 4: remove Jamie from the Louvre only.
    const louvre = rowFor(page, "Louvre");
    await louvre.getByRole("button", { name: "Jamie" }).click();
    await expect(louvre.getByRole("button", { name: "Jamie" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(
      rowFor(page, "Trattoria Roma").getByRole("button", { name: "Jamie" }),
    ).toHaveAttribute("aria-pressed", "true");
    // The design's example: Jamie owes 28.17, Mum 60.17, Dad 60.15.
    await expect(personTotal(page, "Jamie")).toContainText("Owes €28.17");
    await expect(personTotal(page, "Mum")).toContainText("Owes €60.17");
    await expect(personTotal(page, "Dad")).toContainText("Owes €60.15");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    await expectNoSidewaysScroll(page);

    // Confirm or make changes: nothing is added until OK.
    await page.getByRole("button", { name: "Review and add" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm or make changes" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("4 expenses will be added");
    await expect(dialog).toContainText("Shared by Mum, Dad");
    await dialog.getByRole("button", { name: "Make changes" }).click();
    await expect(dialog).toBeHidden();
    expect(await expenseCount(page)).toBe("0 expenses");

    await page.goto(`/imports/${id}`);
    await page.getByRole("button", { name: "Review and add" }).click();
    await page
      .getByRole("dialog", { name: "Confirm or make changes" })
      .getByRole("button", { name: "OK, add to ledger" })
      .click();
    await expect(page.getByText("Added 4 expenses from Alex's screenshot")).toBeVisible();
    await expect(page.getByTestId("imported-expense")).toHaveCount(4);

    // The ledger has them, the edits are in the Louvre's split, and the history shows them.
    expect(await expenseCount(page)).toBe("4 expenses");
    await page.getByRole("link", { name: /Louvre/ }).click();
    const shared = page.locator("section[aria-labelledby=split-between]");
    await expect(shared).toContainText("Mum");
    await expect(shared).toContainText("Dad");
    await expect(shared).not.toContainText("Jamie");
    await page.getByTestId("from-import").click();
    await expect(page).toHaveURL(new RegExp(`/imports/${id}$`));

    // Confirming again (a second tap, a reload) adds nothing. The screenshot went with the confirm.
    await page.goto(`/imports/${id}`);
    await expect(page.getByText("The original screenshot has been deleted.")).toBeVisible();
    expect((await page.request.get(`/api/imports/${id}/image`)).status()).toBe(404);
    await expect(page.getByRole("button", { name: "Review and add" })).toHaveCount(0);
    expect(await expenseCount(page)).toBe("4 expenses");

    // Undo import reverses the whole batch.
    await page.goto(`/imports/${id}`);
    await page.getByRole("button", { name: "Undo import" }).click();
    await page.getByRole("button", { name: "Yes, undo the import" }).click();
    await expect(page.getByText("This import was undone")).toBeVisible();
    expect(await expenseCount(page)).toBe("0 expenses");
  });

  test("Cancel leaves the ledger unchanged", async ({ page }) => {
    const image = screenshot(2);
    await stubRead(image, wireframeExtraction());
    const id = await uploadAndReview(page, image);

    await page.getByRole("button", { name: "Cancel import" }).click();
    await expect(page.getByRole("alertdialog", { name: "Discard this import?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByTestId("import-row")).toHaveCount(4);

    await page.getByRole("button", { name: "Cancel import" }).click();
    await page.getByRole("button", { name: "Discard import" }).click();
    await page.waitForURL("**/expenses");
    await expect(page.getByText("No expenses yet")).toBeVisible();

    await page.goto(`/imports/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Import discarded" })).toBeVisible();
    // The original is gone too.
    const image404 = await page.request.get(`/api/imports/${id}/image`);
    expect(image404.status()).toBe(404);
  });

  test("uploading the same screenshot again is rejected as already imported", async ({ page }) => {
    const image = screenshot(3);
    await stubRead(image, wireframeExtraction());
    const id = await uploadAndReview(page, image);

    await page.goto("/imports/new");
    await page.locator("#screenshot").setInputFiles(image);
    await page.getByRole("button", { name: "Read screenshot" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "already imported" });
    await expect(alert).toContainText("This screenshot was already imported");
    await alert.getByRole("link", { name: "Open it" }).click();
    await expect(page).toHaveURL(new RegExp(`/imports/${id}$`));
  });

  test("a non-uploader can look but cannot confirm", async ({ page, browser }) => {
    const image = screenshot(4);
    await stubRead(image, wireframeExtraction());
    const id = await uploadAndReview(page, image);

    const { context, page: other } = await signedInContext(browser, {
      name: jamie.displayName,
      telegramId: jamie.telegramUserId,
      userId: jamie.id,
    });
    try {
      await other.goto(`/imports/${id}`);
      await expect(other.getByText("This import belongs to Alex")).toBeVisible();
      await expect(other.getByTestId("import-row")).toHaveCount(4);
      await expect(other.getByRole("button", { name: "Review and add" })).toHaveCount(0);
      await expect(other.getByRole("button", { name: "Cancel import" })).toHaveCount(0);
      await expect(other.getByRole("checkbox", { name: /Include Trattoria Roma/ })).toBeDisabled();

      // Calling the API directly is refused too.
      const body = {
        batch: { payerIds: [jamie.id], includePayers: false, mode: "equal", percents: null },
        rows: [],
      };
      const confirm = await context.request.post(`/api/imports/${id}/confirm`, { data: body });
      expect(confirm.status()).toBe(403);
      expect((await confirm.json()) as unknown).toMatchObject({ error: "forbidden" });
      expect((await context.request.post(`/api/imports/${id}/cancel`)).status()).toBe(403);
      expect((await context.request.post(`/api/imports/${id}/undo`)).status()).toBe(403);
      // They can see the original, like any member of the group.
      expect((await context.request.get(`/api/imports/${id}/image`)).status()).toBe(200);
    } finally {
      await context.close();
    }
    expect(await expenseCount(page)).toBe("0 expenses");
  });

  test("a screenshot is private: no session, no image and no import", async ({ page, browser }) => {
    const image = screenshot(5);
    await stubRead(image, wireframeExtraction());
    const id = await uploadAndReview(page, image);

    const mine = await page.request.get(`/api/imports/${id}/image`);
    expect(mine.status()).toBe(200);
    expect(mine.headers()["content-type"]).toBe("image/png");
    expect(mine.headers()["cache-control"]).toContain("no-store");

    const stranger = await browser.newContext();
    try {
      expect((await stranger.request.get(`/api/imports/${id}/image`)).status()).toBe(401);
      expect(
        (await stranger.request.post(`/api/imports/${id}/confirm`, { data: {} })).status(),
      ).toBe(401);
    } finally {
      await stranger.close();
    }
  });

  test("a row that needs input blocks Confirm until it is filled in", async ({ page }) => {
    const image = screenshot(6);
    await stubRead(
      image,
      extraction([
        transaction(),
        transaction({
          merchant: "Kiosk",
          date: null,
          date_text: null,
          date_confidence: "unreadable",
          amount_text: "€3,00",
          amount_value: "3.00",
        }),
      ]),
    );
    await uploadAndReview(page, image);

    const kiosk = rowFor(page, "Kiosk");
    await expect(kiosk.getByText("Needs input", { exact: true })).toBeVisible();
    await expect(kiosk.getByText("Needs a date")).toBeVisible();
    await expect(kiosk.getByRole("checkbox", { name: "Include Kiosk" })).not.toBeChecked();

    // Ticking it without a date is refused.
    await kiosk.getByRole("checkbox", { name: "Include Kiosk" }).check();
    await page.getByRole("button", { name: "Review and add" }).click();
    await expect(page.getByRole("alert").first()).toContainText("One row needs attention");
    await expect(kiosk).toContainText("Pick a valid date");
    await expect(page.getByRole("dialog")).toBeHidden();

    await kiosk.getByLabel("Date").fill("2026-11-04");
    await expect(kiosk.getByText("Needs input", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Review and add" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm or make changes" });
    await expect(dialog).toContainText("2 expenses will be added");
    await dialog.getByRole("button", { name: "OK, add to ledger" }).click();
    await expect(page.getByText("Added 2 expenses")).toBeVisible();
  });

  test("a payment the bank billed in SGD shows what counts and can be corrected before adding", async ({
    page,
  }) => {
    // A card-app screenshot: EUR 100.00 with an unlabeled 144.26 that is the SGD actually charged.
    const image = screenshot(21);
    await stubRead(
      image,
      extraction([
        transaction({
          merchant: "Trenitalia",
          amount_text: "EUR 100.00",
          amount_value: "100.00",
          billed_amount_text: "144.26",
          billed_amount_value: "144.26",
          billed_currency: "SGD",
          category: "transport",
        }),
      ]),
    );
    const id = await uploadAndReview(page, image);

    // The SGD that counts leads; the receipt amount is the smaller print.
    const row = rowFor(page, "Trenitalia");
    await expect(row.getByTestId("row-amount")).toHaveText("S$144.26");
    await expect(row.getByTestId("row-receipt-amount")).toHaveText("€100.00 on the receipt");
    await expect(page.getByTestId("summary")).toContainText("S$144.26");
    await expect(personTotal(page, "Alex")).toContainText("Paid S$144.26");
    await expect(personTotal(page, "Jamie")).toContainText("Owes S$48.09");
    await expectNoSidewaysScroll(page);

    // The amount, its currency and the charged amount can all be changed.
    await row.getByRole("button", { name: "Edit Trenitalia" }).click();
    await expect(row.getByLabel("Amount", { exact: true })).toHaveValue("100.00");
    await expect(row.getByLabel("Currency")).toHaveValue("EUR");
    await expect(row.getByLabel("Charged to your card (optional)")).toHaveValue("144.26");
    await expect(row.getByLabel("Charged in")).toHaveValue("SGD");
    await expectNoSidewaysScroll(page);
    await row.getByLabel("Amount", { exact: true }).fill("120.00");
    await row.getByLabel("Currency").selectOption("CHF");
    await row.getByLabel("Charged to your card (optional)").fill("172.50");
    await expect(row.getByTestId("row-amount")).toHaveText("S$172.50");
    await expect(row.getByTestId("row-receipt-amount")).toHaveText("CHF 120.00 on the receipt");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    // The change is kept: a reload shows it.
    await page.reload();
    await expect(rowFor(page, "Trenitalia").getByTestId("row-amount")).toHaveText("S$172.50");
    await expect(rowFor(page, "Trenitalia").getByTestId("row-receipt-amount")).toHaveText(
      "CHF 120.00 on the receipt",
    );

    // The confirm step shows the counted SGD and leads back to the row's amount.
    await page.getByRole("button", { name: "Review and add" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm or make changes" });
    await expect(dialog.getByTestId("confirm-amount")).toHaveText("S$172.50");
    await expect(dialog).toContainText("CHF 120.00 on the receipt");
    await expect(dialog).toContainText("Jamie owes");
    await expect(dialog).toContainText("S$57.50");
    await dialog.getByRole("button", { name: "Change the amount of Trenitalia" }).click();
    await expect(dialog).toBeHidden();
    const again = rowFor(page, "Trenitalia");
    await expect(again.getByLabel("Amount", { exact: true })).toBeFocused();
    await again.getByLabel("Charged to your card (optional)").fill("150.00");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    await page.getByRole("button", { name: "Review and add" }).click();
    await expect(dialog.getByTestId("confirm-amount")).toHaveText("S$150.00");
    await dialog.getByRole("button", { name: "OK, add to ledger" }).click();
    await expect(page.getByText("Added 1 expense from")).toBeVisible();

    // The ledger records the SGD the card was charged.
    await page.goto("/expenses");
    await expect(page.getByText("Trenitalia")).toBeVisible();
    await expect(page.getByText("S$150.00").first()).toBeVisible();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a link from the chat opens the row's amount for editing", async ({ page }) => {
    const image = screenshot(22);
    await stubRead(
      image,
      extraction([
        transaction({ merchant: "Gelato", amount_text: "€4,50", amount_value: "4.50" }),
        transaction({
          merchant: "Trenitalia",
          amount_text: "EUR 100.00",
          amount_value: "100.00",
          billed_amount_text: "144.26",
          billed_amount_value: "144.26",
          billed_currency: "SGD",
        }),
      ]),
    );
    const id = await uploadAndReview(page, image);
    const rowId = (await rowFor(page, "Trenitalia").getAttribute("id"))?.replace(/^row-/, "");
    expect(rowId).toBeTruthy();

    await page.goto(`/imports/${id}?row=${rowId ?? ""}`);
    const row = rowFor(page, "Trenitalia");
    await expect(row.getByLabel("Amount", { exact: true })).toBeVisible();
    await expect(row.getByLabel("Amount", { exact: true })).toBeFocused();
    // Only that row is open.
    await expect(rowFor(page, "Gelato").getByLabel("Amount", { exact: true })).toHaveCount(0);
    await row.getByLabel("Amount", { exact: true }).fill("101.00");
    await row.getByLabel("Currency").selectOption("USD");
    await expect(row.getByTestId("row-receipt-amount")).toHaveText("US$101.00 on the receipt");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
  });

  test("a failed read leaves an empty draft to enter by hand", async ({ page }) => {
    const image = screenshot(7);
    await stubRead(image, { failure: "refused" });
    await uploadAndReview(page, image);
    await expect(page.getByText("The model would not read this image")).toBeVisible();
    await expect(page.getByTestId("import-row")).toHaveCount(0);

    await page.getByRole("button", { name: "Add a payment by hand" }).click();
    const row = page.getByTestId("import-row");
    await expect(row).toHaveCount(1);
    await row.getByLabel("Description").fill("Gelato");
    await row.getByLabel("Date").fill("2026-11-05");
    await row.getByLabel("Currency").selectOption("EUR");
    await row.getByLabel("Amount", { exact: true }).fill("4.50");
    await expect(row.getByText("Needs input", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Review and add" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "OK, add to ledger" }).click();
    await expect(page.getByText("Added 1 expense from")).toBeVisible();
  });

  test("a possible duplicate of an existing expense is flagged and left unticked", async ({
    page,
  }) => {
    // Enter the Trattoria bill by hand first, as someone might have done in the restaurant.
    await page.goto("/expenses/new");
    await page.getByLabel("Description").fill("Trattoria Roma");
    await page.getByLabel("Amount", { exact: true }).fill("48.50");
    await page.getByLabel("Currency", { exact: true }).selectOption("EUR");
    await page.getByLabel("Date").fill("2026-11-03");
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Trattoria Roma" })).toBeVisible();

    const image = screenshot(8);
    await stubRead(image, wireframeExtraction());
    await uploadAndReview(page, image);
    const row = rowFor(page, "Trattoria Roma");
    await expect(row.getByText("Possible duplicate")).toBeVisible();
    await expect(row.getByRole("checkbox", { name: /Include Trattoria Roma/ })).not.toBeChecked();
    await expect(row.getByRole("link", { name: /Trattoria Roma, 2026-11-03/ })).toBeVisible();
    await expect(page.getByTestId("summary")).toContainText("3 payments");
    // Nothing was dropped: ticking it brings it back into the totals.
    await row.getByRole("checkbox", { name: /Include Trattoria Roma/ }).check();
    await expect(page.getByTestId("summary")).toContainText("4 payments");
  });

  test("the stronger re-read replaces the rows after one more tap", async ({ page }) => {
    const image = screenshot(9);
    await stubRead(
      image,
      extraction([transaction({ merchant: "Trattoria Rma", merchant_confidence: "likely" })]),
    );
    await stubRead(image, extraction([transaction({ merchant: "Trattoria Roma" })]), "reread");
    await uploadAndReview(page, image);
    await expect(rowFor(page, "Trattoria Rma")).toBeVisible();

    await page.getByRole("button", { name: "Re-read with Sonnet" }).click();
    await page.getByRole("button", { name: "Keep my rows" }).click();
    await expect(rowFor(page, "Trattoria Rma")).toBeVisible();

    await page.getByRole("button", { name: "Re-read with Sonnet" }).click();
    await page.getByRole("button", { name: "Re-read", exact: true }).click();
    await expect(rowFor(page, "Trattoria Roma")).toBeVisible();
    await expect(page.getByText("Read by Claude Sonnet 5.5")).toBeVisible();
  });

  test("the scheduled clean-up route is closed to anyone without the secret", async ({ page }) => {
    expect((await page.request.get("/api/cron/retention")).status()).toBe(401);
    const ok = await page.request.get("/api/cron/retention", {
      headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET ?? ""}` },
    });
    expect(ok.status()).toBe(200);
  });
});
