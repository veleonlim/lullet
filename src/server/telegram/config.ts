import { getAppUrl } from "@/lib/auth/config";

/**
 * Bot settings, read from the environment only (never from code or the database). The bot is
 * "not configured" until the token, the webhook secret and the group chat id are all set; the
 * webhook then answers 404 and the web app's announcements quietly do nothing.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface BotConfig {
  readonly token: string;
  /** Checked on every webhook call; also keys the nonce on inline buttons. */
  readonly webhookSecret: string;
  readonly groupChatId: number;
  /** Where the Bot API lives. Only tests change it (to a local fake). */
  readonly apiRoot: string;
  /** The bot's username when known without asking Telegram. */
  readonly botUsername: string | null;
  readonly appUrl: string;
}

export const DEFAULT_API_ROOT = "https://api.telegram.org";

const MIN_SECRET_LENGTH = 16;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function loadBotConfig(env: Env = process.env): BotConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const group = env.TELEGRAM_GROUP_CHAT_ID?.trim();
  if (!token || !webhookSecret || !group) return null;
  if (webhookSecret.length < MIN_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(webhookSecret)) {
    // Telegram only allows A-Z, a-z, 0-9, _ and - in a secret token (1 to 256 characters).
    throw new Error(
      `TELEGRAM_WEBHOOK_SECRET must be at least ${String(MIN_SECRET_LENGTH)} characters of A-Z, a-z, 0-9, _ or - (try \`openssl rand -hex 32\`).`,
    );
  }
  const groupChatId = Number(group);
  if (!Number.isSafeInteger(groupChatId) || groupChatId === 0) {
    throw new Error(
      "TELEGRAM_GROUP_CHAT_ID must be the group's numeric chat id (usually negative).",
    );
  }
  return {
    token,
    webhookSecret,
    groupChatId,
    apiRoot: nonEmpty(env.TELEGRAM_API_ROOT) ?? DEFAULT_API_ROOT,
    botUsername: nonEmpty(env.TELEGRAM_BOT_USERNAME)?.replace(/^@/, "") ?? null,
    appUrl: getAppUrl(env),
  };
}
