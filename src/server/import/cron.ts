import { createHash, timingSafeEqual } from "node:crypto";
import { getDatabase } from "@/db/client";
import { runRetention } from "./retention";
import { getStorage } from "./storage";

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The scheduled clean-up (expire old drafts, delete any original still stored for a closed import). Vercel
 * Cron calls it with `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with no
 * secret configured the route is closed rather than open.
 */
export async function handleRetentionRequest(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || !sameSecret(header.slice(7), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runRetention({ db: getDatabase().db, storage: getStorage() });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
