import { getWebhookRuntime } from "@/server/telegram/runtime";
import { handleWebhook } from "@/server/telegram/webhook";

export const dynamic = "force-dynamic";
// Reading a screenshot with the model happens after the response, inside this limit: two attempts
// of up to 60 s each, plus the download and the replies.
export const maxDuration = 180;

/** Telegram Bot API webhook. Authenticated by the secret-token header, not by a session. */
export function POST(request: Request) {
  return handleWebhook(request, getWebhookRuntime());
}
