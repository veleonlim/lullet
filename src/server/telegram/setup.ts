import { Api } from "grammy";
import type { BotConfig } from "./config";

/**
 * One-time registration with Telegram once the captain has a bot token: the webhook (with the
 * secret token), the command list and the Mini App button. Kept here, not in the script, so the
 * plan can be tested and printed in a dry run without any network call.
 */

export const BOT_COMMANDS = [
  { command: "rate", description: "Set today's default rate, e.g. /rate EUR 1.51" },
  { command: "login", description: "Get a one-time link to the web dashboard" },
  { command: "alias", description: "Give a member another name for captions" },
  { command: "help", description: "How to use the bot" },
] as const;

export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export interface SetupPlan {
  readonly webhookUrl: string;
  readonly miniAppUrl: string;
  readonly commands: typeof BOT_COMMANDS;
  readonly allowedUpdates: typeof ALLOWED_UPDATES;
}

export function buildSetupPlan(config: BotConfig): SetupPlan {
  return {
    webhookUrl: `${config.appUrl}/api/telegram/webhook`,
    miniAppUrl: `${config.appUrl}/signin`,
    commands: BOT_COMMANDS,
    allowedUpdates: ALLOWED_UPDATES,
  };
}

/** Telegram only accepts https addresses for webhooks and Mini Apps. */
export function setupProblem(plan: SetupPlan): string | null {
  return plan.webhookUrl.startsWith("https://")
    ? null
    : `APP_URL must be a public https address (it is ${plan.webhookUrl.replace("/api/telegram/webhook", "")}).`;
}

export interface SetupResult {
  readonly webhookUrl: string;
  readonly pendingUpdates: number;
  readonly lastError: string | null;
}

export async function runSetup(config: BotConfig, plan: SetupPlan): Promise<SetupResult> {
  const api = new Api(config.token, { apiRoot: config.apiRoot });
  await api.setWebhook(plan.webhookUrl, {
    secret_token: config.webhookSecret,
    allowed_updates: [...plan.allowedUpdates],
  });
  await api.setMyCommands(plan.commands.map((c) => ({ ...c })));
  await api.setChatMenuButton({
    menu_button: { type: "web_app", text: "Open lullet", web_app: { url: plan.miniAppUrl } },
  });
  const info = await api.getWebhookInfo();
  return {
    webhookUrl: info.url ?? "",
    pendingUpdates: info.pending_update_count,
    lastError: info.last_error_message ?? null,
  };
}
