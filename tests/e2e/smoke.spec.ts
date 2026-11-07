import { expect, test } from "./fixtures";

// Every page needs a signed-in member, so these run in a page that is already signed in.
test.describe("app shell", () => {
  test("opens on the expense list under the lullet header", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/expenses$/);
    await expect(page).toHaveTitle("Expenses | lullet");
    const banner = page.getByRole("banner");
    await expect(banner.getByText("lullet", { exact: true })).toBeVisible();
    await expect(banner.getByText("Split trip costs, fairly")).toBeVisible();
    await expect(banner.getByText("Europe Split")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Expenses");
  });

  test("fits the viewport without sideways scrolling", async ({ signedInPage: page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBe(0);
  });

  test("is mobile friendly: viewport meta is set and content stays inside a readable column", async ({
    signedInPage: page,
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

  test("loads without console errors or failed requests", async ({ signedInPage: page }) => {
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

  test("follows the system colour scheme", async ({ signedInPage: page }) => {
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

  test("unknown routes give a 404 to a signed-in member", async ({ signedInPage }) => {
    const response = await signedInPage.request.get("/does-not-exist");
    expect(response.status()).toBe(404);
  });

  test("unknown routes reveal nothing to a signed-out visitor", async ({ page }) => {
    await page.goto("/does-not-exist");
    await expect(page).toHaveURL(/\/signin/);
  });
});
