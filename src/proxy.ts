import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/config";

/**
 * First gate: a request with no session cookie never reaches a protected page or API route.
 * This only looks for the cookie (cheap, no database); whether it names a live session is
 * checked for real by the `(app)` layout and by `getSession()` in every page and action.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE_NAME)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const signIn = new URL("/signin", request.url);
  if (request.method === "GET") {
    signIn.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  }
  return NextResponse.redirect(signIn);
}

export const config = {
  // Everything except the public sign-in pages and routes, the health probe, the scheduled jobs and the
  // Telegram webhook (they carry their own secret) and static assets.
  matcher: [
    "/((?!signin(?:/|$)|api/auth/|api/cron/|api/telegram/webhook$|api/health$|_next/|icon\\.svg$).*)",
  ],
};
