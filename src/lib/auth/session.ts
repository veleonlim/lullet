import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "./config";
import { getCurrentUser, type CurrentUser } from "./db/members";
import { deleteSession, resolveSession } from "./db/sessions";

/**
 * The seam the rest of the app uses to learn who is calling. Pages, server actions and route
 * handlers get the caller only from `getSession()`; the data access layer then scopes every
 * query by `groupId`. Nothing else in the app reads the cookie.
 */
export interface Session {
  readonly userId: string;
  readonly groupId: string;
}

const readSession = cache(async (): Promise<(Session & { sessionId: string }) | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return resolveSession(token);
});

/** The signed-in member, or null (signed out, expired, logged out or removed from the group). */
export async function getSession(): Promise<Session | null> {
  const session = await readSession();
  return session ? { userId: session.userId, groupId: session.groupId } : null;
}

/** For pages and layouts that need a member: sends everyone else to the sign-in page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/signin");
  return session;
}

/** The session id (not the secret token); used to spare the current session when revoking others. */
export async function getSessionId(): Promise<string | null> {
  return (await readSession())?.sessionId ?? null;
}

/** The signed-in member with their display name and role, for the header and the members page. */
export const getCurrentMember = cache(async (): Promise<CurrentUser | null> => {
  const session = await getSession();
  return session ? getCurrentUser(session) : null;
});

/** The raw cookie value, only for replacing or ending the session during login and logout. */
export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // Browsers treat http://localhost as a secure context, so this also works in local development.
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/** Logout: forget the session on the server, then drop the cookie. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  if (token) await deleteSession(token);
  // A plain delete would omit `Secure`, and browsers ignore a `__Host-` cookie update without it.
  jar.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
}
