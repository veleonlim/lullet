import type { Update } from "grammy/types";
import * as z from "zod";
import { SECRET_HEADER, secretsMatch } from "@/lib/telegram/secret";
import { describeFailure } from "./api";
import type { BotConfig } from "./config";

/**
 * The webhook, as a plain function of a Request so it runs the same behind Next's route handler,
 * on another host, and in tests. Telegram needs an answer fast, so the update is checked and
 * acknowledged here and the real work is handed to `defer` (Next's `after` on Vercel), which
 * keeps the function alive until the work is done.
 */
export interface WebhookRuntime {
  /** Null while the bot is not configured; the webhook then pretends not to exist. */
  readonly config: BotConfig | null;
  readonly defer: (task: () => Promise<unknown>) => void;
  readonly process: (update: Update) => Promise<unknown>;
}

/** Real updates are a few kilobytes; anything larger is not from Telegram. */
const MAX_BODY_BYTES = 1_000_000;

const updateShape = z.object({ update_id: z.number().int().nonnegative() }).loose();

function refuse(status: number, reason: string): Response {
  console.warn(`Telegram webhook refused with ${status}: ${reason}`);
  return new Response(null, { status });
}

export async function handleWebhook(request: Request, runtime: WebhookRuntime): Promise<Response> {
  const { config } = runtime;
  if (!config) return refuse(404, "the bot is not configured (token, webhook secret or group id)");
  const secret = request.headers.get(SECRET_HEADER);
  if (secret === null) return refuse(401, "the secret token header is missing");
  if (!secretsMatch(secret, config.webhookSecret)) {
    return refuse(401, "the secret token does not match TELEGRAM_WEBHOOK_SECRET");
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return refuse(413, "the declared body is too large");
  const text = await request.text().catch(() => null);
  if (text === null) return refuse(413, "the body could not be read");
  if (text.length > MAX_BODY_BYTES) return refuse(413, "the body is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "the body is not valid JSON");
  }
  const parsed = updateShape.safeParse(body);
  if (!parsed.success) return refuse(400, "the body is not a Telegram update");

  const update = body as Update;
  runtime.defer(async () => {
    try {
      await runtime.process(update);
    } catch (error) {
      console.error("Telegram webhook processing failed", describeFailure(error));
    }
  });
  return Response.json({ ok: true });
}
