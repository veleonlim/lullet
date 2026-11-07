import { SEED_GROUP_ID, SEED_MEMBERS } from "@/db/seed-ids";

/**
 * The caller. Pages and server actions obtain who is asking only through
 * `getSession`, and the ledger data layer scopes every query by this group.
 *
 * This module is the seam with Telegram sign-in, which owns `src/lib/auth/`. Until
 * that lands this file holds a development stand-in that returns the first seeded
 * member, and only when LULLET_DEV_AUTH=1 on a non production deployment. The real
 * implementation replaces `getSession` and keeps this exact signature.
 */
export interface Session {
  readonly userId: string;
  readonly groupId: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The development sign-in is allowed only when it is asked for and the process is not a
 * production deployment: never on Vercel production or preview, never in a production
 * build unless the end to end suite explicitly serves one (LULLET_E2E=1, set only by
 * playwright.config.ts).
 */
export function isDevAuthEnabled(env: Environment): boolean {
  if (env.LULLET_DEV_AUTH !== "1") return false;
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return false;
  if (env.NODE_ENV === "production" && env.LULLET_E2E !== "1") return false;
  return true;
}

export function getSession(): Promise<Session | null> {
  return Promise.resolve(sessionFromEnvironment(process.env));
}

/** Exported for tests, which pass an explicit environment instead of mutating `process.env`. */
export function sessionFromEnvironment(env: Environment): Session | null {
  if (!isDevAuthEnabled(env)) return null;
  const member = SEED_MEMBERS[0];
  return { userId: member.id, groupId: SEED_GROUP_ID };
}
