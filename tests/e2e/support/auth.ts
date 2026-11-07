import { randomInt } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createDatabase, type DatabaseHandle } from "@/db/client";
import { mintLoginLink } from "@/lib/auth/db/login-links";
import { bootstrapGroup } from "@/lib/auth/db/members";
import { buildInitData, TEST_BOT_TOKEN } from "@/test-support/telegram";

export { TEST_BOT_TOKEN };

let handle: DatabaseHandle | undefined;

function database() {
  handle ??= createDatabase({
    connectionString: process.env.E2E_DATABASE_URL ?? "",
    max: 2,
  });
  return handle.db;
}

function authDeps(now?: Date) {
  return {
    db: database(),
    secret: process.env.SESSION_SECRET ?? "",
    ...(now ? { now } : {}),
  };
}

export interface SeededMember {
  readonly name: string;
  readonly telegramId: number;
  readonly userId: string;
}

export interface SeededGroup {
  readonly groupId: string;
  /** The first member is the owner. */
  readonly owner: SeededMember;
  readonly mei: SeededMember;
  readonly mum: SeededMember;
  readonly dad: SeededMember;
}

/** A Telegram id no other test uses (they are unique per group in the database). */
export const freshTelegramId = (): number => randomInt(1_000_000_000, 9_000_000_000);

/** Creates a fresh four member group; every test gets its own so tests stay independent. */
export async function seedGroup(): Promise<SeededGroup> {
  const members = ["Veleon", "Mei", "Mum", "Dad"].map((name) => ({
    displayName: name,
    telegramUserId: freshTelegramId(),
  }));
  const { groupId, userIds } = await bootstrapGroup(
    { groupName: "Switzerland and Italy", members },
    authDeps(),
  );
  const seeded = members.map((m, i) => ({
    name: m.displayName,
    telegramId: m.telegramUserId,
    userId: userIds[i] ?? "",
  }));
  const [owner, mei, mum, dad] = seeded;
  if (!owner || !mei || !mum || !dad) throw new Error("seed failed");
  return { groupId, owner, mei, mum, dad };
}

/** What the bot would DM: a one-time login link for an allowlisted Telegram user. */
export async function mintLink(telegramId: number, now?: Date): Promise<string> {
  const link = await mintLoginLink(telegramId, {}, authDeps(now));
  if (!link) throw new Error(`no link minted for ${telegramId}`);
  return link.url;
}

/** Opens a login link and confirms it, like a person tapping the link the bot sent. */
export async function signInWithLink(page: Page, member: SeededMember): Promise<void> {
  await page.goto(await mintLink(member.telegramId));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("signed-in-as")).toHaveText(member.name);
  // Let the navigation settle so nothing from it is still in flight when a test moves on.
  await page.waitForLoadState("networkidle");
}

export async function signedInContext(
  browser: Browser,
  member: SeededMember,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWithLink(page, member);
  return { context, page };
}

export function signedInitData(
  telegramId: number,
  options: { ageSeconds?: number; botToken?: string } = {},
): string {
  return buildInitData({
    userId: telegramId,
    firstName: "Tester",
    authDate: new Date(Date.now() - (options.ageSeconds ?? 5) * 1000),
    botToken: options.botToken ?? TEST_BOT_TOKEN,
  });
}

/**
 * Puts a session cookie value into a browser, the way someone holding a copy of it would. (Done
 * from the page because Playwright's cookie API refuses `__Host-` cookies on plain http.)
 */
export async function plantSessionCookie(page: Page, value: string): Promise<void> {
  await page.goto("/signin");
  await page.evaluate(
    ([name, cookieValue]) => {
      document.cookie = `${name}=${cookieValue}; Path=/; Secure; SameSite=Lax`;
    },
    ["__Host-lullet_session", value],
  );
}
