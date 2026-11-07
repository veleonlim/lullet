import { getBotToken } from "../config";
import { type AuthDeps } from "../deps";
import { verifyInitData, type InitDataFailure } from "../init-data";
import { redeemLoginToken } from "./login-links";
import { findMemberByTelegramId, type Member } from "./members";
import { createSession, type CreatedSession } from "./sessions";

export type SignInResult =
  | { readonly ok: true; readonly member: Member; readonly session: CreatedSession }
  | { readonly ok: false; readonly reason: InitDataFailure | "not_allowed" | "invalid_link" };

interface SignInOptions {
  /** The session token the browser already holds, if any; it is destroyed by this login. */
  readonly replacing?: string | undefined;
}

/** Mini App login: verified Telegram init data from an allowlisted account becomes a session. */
export async function signInWithInitData(
  initData: string,
  options: SignInOptions & { readonly botToken?: string; readonly maxAgeSeconds?: number } = {},
  deps?: AuthDeps,
): Promise<SignInResult> {
  const verified = verifyInitData(initData, options.botToken ?? getBotToken(), {
    ...(deps?.now ? { now: deps.now } : {}),
    ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
  });
  if (!verified.ok) return verified;
  const member = await findMemberByTelegramId(verified.user.id, deps);
  if (!member) return { ok: false, reason: "not_allowed" };
  const session = await createSession(member, { replacing: options.replacing }, deps);
  return { ok: true, member, session };
}

/** Browser login: a valid, unused, unexpired link becomes a session, and is used up. */
export async function signInWithLoginToken(
  token: string,
  options: SignInOptions = {},
  deps?: AuthDeps,
): Promise<SignInResult> {
  const member = await redeemLoginToken(token, deps);
  if (!member) return { ok: false, reason: "invalid_link" };
  const session = await createSession(member, { replacing: options.replacing }, deps);
  return { ok: true, member, session };
}
