import { expect, test } from "./fixtures";
import {
  freshTelegramId,
  mintLink,
  signedInContext,
  signedInitData,
  plantSessionCookie,
  signInWithLink,
  TEST_BOT_TOKEN,
} from "./support/auth";

const SESSION_COOKIE = "__Host-lullet_session";

test.describe("signed out", () => {
  test("pages send a visitor to a sign-in page that explains how to sign in via the bot", async ({
    page,
  }) => {
    await page.goto("/members");
    await expect(page).toHaveURL(/\/signin\?next=%2Fmembers$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in with Telegram" }),
    ).toBeVisible();
    await expect(page.getByText("start a chat with the lullet bot")).toBeVisible();
    await expect(page.getByText("/login")).toBeVisible();
    // No member data or navigation leaks to a signed-out visitor.
    await expect(page.getByRole("link", { name: "Members" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("the home page is protected too", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole("heading", { level: 2, name: "Coming next" })).toHaveCount(0);
  });

  test("the retired LULLET_DEV_AUTH flag, set on the test server, signs nobody in", async ({
    page,
    request,
  }) => {
    await page.goto("/expenses");
    await expect(page).toHaveURL(/\/signin\?next=%2Fexpenses$/);
    await expect(page.getByTestId("signed-in-as")).toHaveCount(0);
    expect((await request.get("/api/anything", { maxRedirects: 0 })).status()).toBe(401);
  });

  test("API routes answer 401 and the health probe stays public", async ({ request }) => {
    const denied = await request.get("/api/anything", { maxRedirects: 0 });
    expect(denied.status()).toBe(401);
    expect((await request.get("/api/health")).status()).toBe(200);
  });

  test("a forged or garbage cookie is not a session", async ({ page }) => {
    await plantSessionCookie(page, "forged");
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in with Telegram" }),
    ).toBeVisible();
  });

  test("the sign-in page does not redirect to another site through ?next", async ({
    page,
    group,
  }) => {
    await page.goto(await mintLink(group.mei.telegramId));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.goto("/signin?next=https://evil.example/");
    await expect(page).toHaveURL(/localhost/);
  });
});

test.describe("login link", () => {
  test("signs the member in with a hardened session cookie, and survives a reload", async ({
    page,
    context,
    group,
    baseURL,
  }) => {
    const link = await mintLink(group.mei.telegramId);
    await page.goto(link);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in as Mei?" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.getByTestId("signed-in-as")).toHaveText("Mei");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Split the trip, not the friendship.",
    );

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === SESSION_COOKIE);
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(session?.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 24 * 3600);
    // Page scripts cannot read it.
    expect(await page.evaluate(() => document.cookie)).toBe("");
    // The cookie holds an opaque token, not an identity.
    expect(session?.value).not.toContain(group.mei.userId);

    await page.reload();
    await expect(page.getByTestId("signed-in-as")).toHaveText("Mei");
    // Already signed in: the sign-in page forwards to the app.
    await page.goto("/signin");
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test("the signed-in member can reach the members page and sees who is on the list", async ({
    signedInPage: page,
    group,
  }) => {
    await page.getByRole("link", { name: "Members" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await expect(page.getByTestId("member")).toHaveCount(4);
    await expect(page.getByTestId("member").first()).toContainText("Veleon");
    await expect(page.getByTestId("member").first()).toContainText("Owner");
    await expect(page.getByTestId("member").first()).toContainText(String(group.owner.telegramId));
    // A member who is not the owner gets no re-bind controls.
    await expect(page.getByRole("button", { name: "Re-bind" })).toHaveCount(0);
  });

  test("opening or previewing the link does not use it up; confirming does, once", async ({
    page,
    browser,
    group,
  }) => {
    const link = await mintLink(group.mum.telegramId);
    // A link preview is just GET requests.
    for (let i = 0; i < 3; i += 1) {
      expect((await page.request.get(link)).status()).toBe(200);
    }
    await page.goto(link);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("signed-in-as")).toHaveText("Mum");

    // Replaying the same link, even from a fresh browser, is refused.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(link);
    await expect(
      otherPage.getByRole("heading", { name: "This link no longer works" }),
    ).toBeVisible();
    await expect(otherPage.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await other.close();
  });

  test("a link used twice at the same moment signs in only one browser", async ({
    browser,
    group,
  }) => {
    const link = await mintLink(group.dad.telegramId);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    await Promise.all(pages.map((p) => p.goto(link)));
    await Promise.all(pages.map((p) => p.getByRole("button", { name: "Continue" }).click()));
    await Promise.all(pages.map((p) => p.waitForLoadState("networkidle")));

    const signedIn = await Promise.all(
      contexts.map(async (c) =>
        (await c.cookies()).some((cookie) => cookie.name === SESSION_COOKIE),
      ),
    );
    expect(signedIn.filter(Boolean)).toHaveLength(1);
    await Promise.all(contexts.map((c) => c.close()));
  });

  test("an expired link is refused", async ({ page, group }) => {
    const link = await mintLink(group.mei.telegramId, new Date(Date.now() - 11 * 60 * 1000));
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
    await expect(page.getByText("Send /login to the lullet bot")).toBeVisible();
  });

  test("a made-up link is refused, and a forced confirmation lands on the sign-in page with an explanation", async ({
    page,
  }) => {
    await page.goto("/signin/link/not-a-real-token");
    await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible();

    const response = await page.request.post("/api/auth/link", {
      form: { token: "not-a-real-token" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe("/signin?error=link");
    expect(response.headers()["set-cookie"]).toBeUndefined();

    await page.goto("/signin?error=link");
    await expect(page.locator("main").getByRole("alert")).toContainText("did not work");
  });

  test("the link endpoint refuses requests that browsers mark as cross-site", async ({
    request,
    group,
  }) => {
    const link = await mintLink(group.mei.telegramId);
    const response = await request.post("/api/auth/link", {
      form: { token: link.slice(link.lastIndexOf("/") + 1) },
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
    // The refused request did not use the link up.
    const preview = await request.get(link);
    expect(await preview.text()).toContain('name="token"');
  });
});

test.describe("sessions", () => {
  test("signing out ends the session on the server and lands on the sign-in page", async ({
    page,
    context,
    browser,
    group,
    baseURL,
  }) => {
    await signInWithLink(page, group.mei);
    const stolen = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(stolen).toBeDefined();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${baseURL}/signin`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in with Telegram" }),
    ).toBeVisible();
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);

    // Even a copy of the old cookie no longer works: the server forgot the session.
    const replay = await browser.newContext();
    const replayPage = await replay.newPage();
    await plantSessionCookie(replayPage, stolen?.value ?? "");
    await replayPage.goto("/members");
    await expect(replayPage).toHaveURL(/\/signin/);
    await replay.close();
  });

  test("logging in again rotates the session cookie and retires the old one", async ({
    page,
    context,
    browser,
    group,
  }) => {
    await signInWithLink(page, group.mei);
    const first = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);

    await page.goto(await mintLink(group.mei.telegramId));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("signed-in-as")).toHaveText("Mei");
    const second = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(second?.value).not.toBe(first?.value);

    const old = await browser.newContext();
    const oldPage = await old.newPage();
    await plantSessionCookie(oldPage, first?.value ?? "");
    await oldPage.goto("/");
    await expect(oldPage).toHaveURL(/\/signin/);
    await old.close();
  });

  test("two members signed in at once stay separate", async ({ browser, group }) => {
    const mei = await signedInContext(browser, group.mei);
    const mum = await signedInContext(browser, group.mum);
    await expect(mei.page.getByTestId("signed-in-as")).toHaveText("Mei");
    await expect(mum.page.getByTestId("signed-in-as")).toHaveText("Mum");
    await mei.page.getByRole("button", { name: "Sign out" }).click();
    await mum.page.reload();
    await expect(mum.page.getByTestId("signed-in-as")).toHaveText("Mum");
    await mei.context.close();
    await mum.context.close();
  });
});

test.describe("Telegram Mini App", () => {
  test("opening the app from the bot signs an allowlisted member in automatically", async ({
    page,
    group,
    baseURL,
  }) => {
    const initData = signedInitData(group.mum.telegramId);
    await page.goto(
      `/signin?next=/members#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=9.0`,
    );
    await expect(page).toHaveURL(`${baseURL}/members`);
    await expect(page.getByTestId("signed-in-as")).toHaveText("Mum");
  });

  test("a validly signed Telegram user who is not on the allowlist is refused", async ({
    page,
    context,
    request,
  }) => {
    const stranger = freshTelegramId();
    const initData = signedInitData(stranger);

    const response = await request.post("/api/auth/telegram", { data: { initData } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "not_allowed" });
    expect(response.headers()["set-cookie"]).toBeUndefined();

    await page.goto(`/signin#tgWebAppData=${encodeURIComponent(initData)}`);
    await expect(page.locator("main").getByRole("alert")).toContainText("not on the list");
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);
  });

  test("forged, wrong-bot and stale init data are refused with no cookie", async ({
    request,
    group,
  }) => {
    const id = group.mei.telegramId;
    const attempts = {
      forged: signedInitData(id).replace(/hash=[0-9a-f]{4}/, "hash=0000"),
      wrongBot: signedInitData(id, { botToken: "999999:not-our-bot" }),
      stale: signedInitData(id, { ageSeconds: 2 * 3600 }),
      garbage: "not=init&data=at-all",
    };
    for (const initData of Object.values(attempts)) {
      const response = await request.post("/api/auth/telegram", { data: { initData } });
      expect(response.status()).toBe(401);
      expect(response.headers()["set-cookie"]).toBeUndefined();
    }
    expect(TEST_BOT_TOKEN).not.toContain("999999");

    const malformed = await request.post("/api/auth/telegram", { data: { nothing: true } });
    expect(malformed.status()).toBe(400);
  });

  test("a good init data posted directly gives a session cookie that works", async ({
    page,
    group,
  }) => {
    const response = await page.request.post("/api/auth/telegram", {
      data: { initData: signedInitData(group.dad.telegramId) },
    });
    expect(response.status()).toBe(200);
    await page.goto("/");
    await expect(page.getByTestId("signed-in-as")).toHaveText("Dad");
  });
});

test.describe("owner re-bind", () => {
  test("the owner points a member at a new Telegram account", async ({ browser, group }) => {
    const owner = await signedInContext(browser, group.owner);
    const mei = await signedInContext(browser, group.mei);
    const newId = freshTelegramId();

    await owner.page.goto("/members");
    const row = owner.page.getByTestId("member").filter({ hasText: "Mei" });
    await row.getByLabel("New Telegram user id for Mei").fill(String(newId));
    await row.getByRole("button", { name: "Re-bind" }).click();
    await expect(row.getByRole("status")).toContainText("Re-bound");
    await expect(row).toContainText(String(newId));

    // Mei's old sign-in is gone; the old Telegram account gets no link; the new one does.
    await mei.page.reload();
    await expect(mei.page).toHaveURL(/\/signin/);
    await expect(mintLink(group.mei.telegramId)).rejects.toThrow(/no link minted/);
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto(await mintLink(newId));
    await expect(freshPage.getByRole("heading", { name: "Sign in as Mei?" })).toBeVisible();
    await freshPage.getByRole("button", { name: "Continue" }).click();
    await expect(freshPage.getByTestId("signed-in-as")).toHaveText("Mei");

    // The owner's own session is untouched.
    await owner.page.reload();
    await expect(owner.page.getByTestId("signed-in-as")).toHaveText("Veleon");
    await Promise.all([owner.context.close(), mei.context.close(), fresh.close()]);
  });

  test("an id already linked to someone else is refused with a message", async ({
    browser,
    group,
  }) => {
    const owner = await signedInContext(browser, group.owner);
    await owner.page.goto("/members");
    const row = owner.page.getByTestId("member").filter({ hasText: "Mei" });
    await row.getByLabel("New Telegram user id for Mei").fill(String(group.mum.telegramId));
    await row.getByRole("button", { name: "Re-bind" }).click();
    await expect(row.getByRole("alert")).toContainText("already linked");
    await expect(row).toContainText(String(group.mei.telegramId));
    await owner.context.close();
  });

  test("an id that is not a number is refused", async ({ browser, group }) => {
    const owner = await signedInContext(browser, group.owner);
    await owner.page.goto("/members");
    const row = owner.page.getByTestId("member").filter({ hasText: "Dad" });
    // The field is numeric on a phone keyboard, but nothing stops typing letters on a desktop.
    await row.getByLabel("New Telegram user id for Dad").fill("@dad");
    await row.getByRole("button", { name: "Re-bind" }).click();
    await expect(row.getByRole("alert")).toContainText("digits only");
    await owner.context.close();
  });
});
