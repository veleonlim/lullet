import { test as base, expect, type Page } from "@playwright/test";
import { seedGroup, signInWithLink, type SeededGroup } from "./support/auth";

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

export { expect };
