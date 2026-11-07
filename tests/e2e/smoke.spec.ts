import { expect, test } from "@playwright/test";

test.describe("app shell", () => {
  test("renders the placeholder home page", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle("lullet");
    await expect(page.getByRole("banner").getByText("lullet")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Split the trip, not the friendship.",
    );
    await expect(page.getByRole("heading", { level: 2, name: "Coming next" })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveText([/Ledger/, /Balances/, /Telegram/]);
  });

  test("fits the viewport without sideways scrolling", async ({ page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBe(0);
  });

  test("is mobile friendly: viewport meta is set and content stays inside a readable column", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /width=device-width/,
    );
    const box = await page.getByRole("main").boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeLessThanOrEqual(768);
  });

  test("loads without console errors or failed requests", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()}`));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  test("follows the system colour scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light).not.toBe(dark);
  });
});

test.describe("health endpoint", () => {
  test("reports ok without touching the database", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("unknown routes give a 404", async ({ request }) => {
    const response = await request.get("/does-not-exist");
    expect(response.status()).toBe(404);
  });
});
