import { test as base, expect, type Page } from "@playwright/test";
import { seedGroup, signInWithLink, type SeededGroup } from "./support/auth";
import { SEED_MEMBERS } from "@/db/seed-ids";

/**
 * The Next dev badge sits over the leftmost tab of the phone tab bar and intercepts taps, so test pages
 * hide the dev tools portal.
 */
async function hideNextDevTools(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    const attach = () => document.documentElement.append(style);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
    else attach();
  });
}

interface Fixtures {
  /** A fresh four member group, seeded for this test only. */
  group: SeededGroup;
  /** A page already signed in as the group's second member (not the owner). */
  signedInPage: Page;
}

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    await hideNextDevTools(page);
    await use(page);
  },
  group: async ({}, use) => {
    await use(await seedGroup());
  },
  signedInPage: async ({ page, group }, use) => {
    await signInWithLink(page, group.mei);
    await use(page);
  },
});

/** The ledger specs: every page is signed in, through the login-link flow, as the seeded first member. */
export const ledgerTest = base.extend({
  page: async ({ page }, use) => {
    await hideNextDevTools(page);
    const [alex] = SEED_MEMBERS;
    await signInWithLink(page, {
      name: alex.displayName,
      telegramId: alex.telegramUserId,
      userId: alex.id,
    });
    await use(page);
  },
});

export { expect };
