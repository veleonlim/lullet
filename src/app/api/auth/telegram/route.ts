import { NextResponse } from "next/server";
import * as z from "zod";
import { SESSION_COOKIE_NAME } from "@/lib/auth/config";
import { signInWithInitData } from "@/lib/auth/db/login";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getSessionToken, sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ initData: z.string().min(1).max(4096) });

/**
 * Mini App login. The page inside Telegram posts `Telegram.WebApp.initData`; it is verified
 * against the bot token, the Telegram user must be on the allowlist, and a fresh session cookie
 * is issued. Failures say only what the user can act on and never set a cookie.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const previous = await getSessionToken();

  const result = await signInWithInitData(body.data.initData, { replacing: previous });
  if (!result.ok) {
    return result.reason === "not_allowed"
      ? NextResponse.json({ error: "not_allowed" }, { status: 403 })
      : NextResponse.json({ error: "invalid_init_data" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE_NAME,
    result.session.token,
    sessionCookieOptions(result.session.expiresAt),
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
