import { and, eq, gt, isNull } from "drizzle-orm";
import * as s from "@/db/schema";
import { getAppUrl, LOGIN_LINK_TTL_SECONDS } from "../config";
import { addSeconds, resolveDeps, type AuthDeps } from "../deps";
import { generateToken, hashToken } from "../tokens";
import { findMemberByTelegramId, findMemberByUserId, type Member } from "./members";

/** The path a login link points at; the page behind it asks for a click before consuming it. */
export const LOGIN_LINK_PATH = "/signin/link";

export interface MintedLoginLink {
  /** The full URL to send to the user. It is the only copy: only a hash is stored. */
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * Mints a one-time login link for an allowlisted Telegram user. This is what the bot calls when
 * a member asks for a browser login. It returns null for anyone not on the allowlist, so the
 * bot can stay silent or refuse. Older unused links of the same member are withdrawn first, so
 * at most one link is live per member.
 */
export async function mintLoginLink(
  telegramUserId: number,
  options: { readonly baseUrl?: string; readonly ttlSeconds?: number } = {},
  deps?: AuthDeps,
): Promise<MintedLoginLink | null> {
  const { db, secret, now } = resolveDeps(deps);
  const member = await findMemberByTelegramId(telegramUserId, deps);
  if (!member) return null;

  const token = generateToken();
  const expiresAt = addSeconds(now, options.ttlSeconds ?? LOGIN_LINK_TTL_SECONDS);
  await db.transaction(async (tx) => {
    await tx
      .delete(s.loginTokens)
      .where(and(eq(s.loginTokens.userId, member.userId), isNull(s.loginTokens.consumedAt)));
    await tx.insert(s.loginTokens).values({
      tokenHash: hashToken(secret, token),
      userId: member.userId,
      createdAt: now,
      expiresAt,
    });
  });
  const base = options.baseUrl ?? getAppUrl();
  return { url: `${base}${LOGIN_LINK_PATH}/${token}`, expiresAt };
}

/**
 * Who a link would sign in, without using it up. The confirmation page shows this so that a link
 * preview (Telegram fetches URLs in messages) or a stray GET cannot burn the one-time token.
 */
export async function peekLoginToken(
  token: string,
  deps?: AuthDeps,
): Promise<{ displayName: string } | null> {
  const { db, secret, now } = resolveDeps(deps);
  const [row] = await db
    .select({ displayName: s.users.displayName })
    .from(s.loginTokens)
    .innerJoin(s.users, eq(s.users.id, s.loginTokens.userId))
    .where(
      and(
        eq(s.loginTokens.tokenHash, hashToken(secret, token)),
        isNull(s.loginTokens.consumedAt),
        gt(s.loginTokens.expiresAt, now),
      ),
    );
  return row ?? null;
}

/**
 * Uses a login link up. The conditional UPDATE is the whole guarantee: of any number of
 * concurrent or repeated attempts, exactly one finds the row unconsumed and unexpired, and the
 * rest get null. Returns the member to sign in, or null for an unknown, expired, used or revoked link.
 */
export async function redeemLoginToken(token: string, deps?: AuthDeps): Promise<Member | null> {
  const { db, secret, now } = resolveDeps(deps);
  const [consumed] = await db
    .update(s.loginTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(s.loginTokens.tokenHash, hashToken(secret, token)),
        isNull(s.loginTokens.consumedAt),
        gt(s.loginTokens.expiresAt, now),
      ),
    )
    .returning({ userId: s.loginTokens.userId });
  if (!consumed) return null;
  // The member must still be on the allowlist at the moment of use.
  return findMemberByUserId(consumed.userId, deps);
}
