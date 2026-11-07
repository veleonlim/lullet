import { test as base, expect, type Page } from "@playwright/test";
import { seedGroup, signInWithLink, type SeededGroup } from "./support/auth";
import { SEED_MEMBERS } from "@/db/seed-ids";

interface Fixtures {
  /** A fresh four member group, seeded for this test only. */
  group: SeededGroup;
  /** A page already signed in as the group's second member (not the owner). */
  signedInPage: Page;
}

export const test = base.extend<Fixtures>({
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
