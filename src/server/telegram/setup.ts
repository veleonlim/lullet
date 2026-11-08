import { Api } from "grammy";
import type { BotConfig } from "./config";

/**
 * One-time registration with Telegram once the captain has a bot token: the webhook (with the
 * secret token), the command list and the Mini App button. Kept here, not in the script, so the
 * plan can be tested and printed in a dry run without any network call.
 */

export const BOT_COMMANDS = [
  {
    command: "import",
    description:
      "Caption a screenshot in the group with it, e.g. /import split between mei and dad",
  },
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
  /** The bot Telegram says the token belongs to. */
  readonly botUsername: string;
  readonly webhookUrl: string;
  readonly pendingUpdates: number;
  readonly lastError: string | null;
}

/**
 * Safe to run again and again: every call sets state rather than adding to it, and no pending
 * update is dropped. `getMe` goes first so a wrong token fails before anything is changed.
 */
export async function runSetup(config: BotConfig, plan: SetupPlan): Promise<SetupResult> {
  const api = new Api(config.token, { apiRoot: config.apiRoot });
  const me = await api.getMe();
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
    botUsername: me.username,
    webhookUrl: info.url ?? "",
    pendingUpdates: info.pending_update_count,
    lastError: info.last_error_message ?? null,
  };
}
