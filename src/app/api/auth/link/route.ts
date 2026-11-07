import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/config";
import { signInWithLoginToken } from "@/lib/auth/db/login";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getSessionToken, sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function redirectTo(path: string): NextResponse {
  // 303 turns the form POST into a GET of the destination. A relative Location is valid HTTP and
  // keeps working behind any proxy or CDN.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: path, "Cache-Control": "no-store" },
  });
}

/**
 * Redeems a one-time login link. The link page posts the token here after the user clicks
 * "Continue", so merely opening or previewing the link never uses it up. On success the old
 * session (if any) is replaced by a brand new one.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const form = await request.formData().catch(() => null);
  const token = form?.get("token");
  if (typeof token !== "string" || token.length === 0 || token.length > 256) {
    return redirectTo("/signin?error=link");
  }

  const previous = await getSessionToken();

  const result = await signInWithLoginToken(token, { replacing: previous });
  if (!result.ok) return redirectTo("/signin?error=link");

  const response = redirectTo("/");
  response.cookies.set(
    SESSION_COOKIE_NAME,
    result.session.token,
    sessionCookieOptions(result.session.expiresAt),
  );
  return response;
}
