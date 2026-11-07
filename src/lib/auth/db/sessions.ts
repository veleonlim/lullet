import { and, eq, gt, lt, ne } from "drizzle-orm";
import * as s from "@/db/schema";
import { SESSION_TTL_SECONDS } from "../config";
import { addSeconds, resolveDeps, type AuthDeps } from "../deps";
import { generateToken, hashToken } from "../tokens";
import type { Member } from "./members";

export interface ResolvedSession extends Member {
  readonly sessionId: string;
}

export interface CreatedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Starts a session for a member and returns the cookie value. Every login gets a brand new token:
 * when the browser already had a session (`replacing`), that one is destroyed in the same
 * transaction, so a token planted before login is useless afterwards (no session fixation).
 * Expired sessions and login links are swept here so the tables stay small without a cron job.
 */
export async function createSession(
  member: Member,
  options: { readonly replacing?: string | undefined } = {},
  deps?: AuthDeps,
): Promise<CreatedSession> {
  const { db, secret, now } = resolveDeps(deps);
  const token = generateToken();
  const expiresAt = addSeconds(now, SESSION_TTL_SECONDS);
  await db.transaction(async (tx) => {
    if (options.replacing) {
      await tx
        .delete(s.sessions)
        .where(eq(s.sessions.tokenHash, hashToken(secret, options.replacing)));
    }
    await tx.delete(s.sessions).where(lt(s.sessions.expiresAt, now));
    await tx.delete(s.loginTokens).where(lt(s.loginTokens.expiresAt, now));
    await tx.insert(s.sessions).values({
      tokenHash: hashToken(secret, token),
      userId: member.userId,
      groupId: member.groupId,
      createdAt: now,
      expiresAt,
    });
  });
  return { token, expiresAt };
}

/**
 * The member behind a cookie value, or null when the token is unknown, expired, or the member
 * has since left the group. The join on `memberships` is what ties a session to current membership.
 */
export async function resolveSession(
  token: string,
  deps?: AuthDeps,
): Promise<ResolvedSession | null> {
  const { db, secret, now } = resolveDeps(deps);
  const [row] = await db
    .select({
      sessionId: s.sessions.id,
      userId: s.sessions.userId,
      groupId: s.sessions.groupId,
    })
    .from(s.sessions)
    .innerJoin(
      s.memberships,
      and(
        eq(s.memberships.groupId, s.sessions.groupId),
        eq(s.memberships.userId, s.sessions.userId),
      ),
    )
    .innerJoin(s.telegramLinks, eq(s.telegramLinks.userId, s.sessions.userId))
    .where(and(eq(s.sessions.tokenHash, hashToken(secret, token)), gt(s.sessions.expiresAt, now)));
  return row ?? null;
}

/** Logout: the server forgets the session, so a copied cookie stops working too. */
export async function deleteSession(token: string, deps?: AuthDeps): Promise<void> {
  const { db, secret } = resolveDeps(deps);
  await db.delete(s.sessions).where(eq(s.sessions.tokenHash, hashToken(secret, token)));
}

/** Ends every session of a user, optionally sparing one. */
export async function revokeUserSessions(
  userId: string,
  options: { readonly exceptSessionId?: string } = {},
  deps?: AuthDeps,
): Promise<void> {
  const { db } = resolveDeps(deps);
  await db
    .delete(s.sessions)
    .where(
      and(
        eq(s.sessions.userId, userId),
        options.exceptSessionId ? ne(s.sessions.id, options.exceptSessionId) : undefined,
      ),
    );
}
