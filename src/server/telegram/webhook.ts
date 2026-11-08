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

const empty = (status: number) => new Response(null, { status });

export async function handleWebhook(request: Request, runtime: WebhookRuntime): Promise<Response> {
  const { config } = runtime;
  if (!config) return empty(404);
  if (!secretsMatch(request.headers.get(SECRET_HEADER), config.webhookSecret)) return empty(401);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return empty(413);
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return empty(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const parsed = updateShape.safeParse(body);
  if (!parsed.success) return empty(400);

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
