/**
 * Auth settings, read from the environment only. Nothing here needs a real Telegram bot at test
 * time: tests pass their own values in. Every getter throws a clear message when a value is
 * missing so a misconfigured deploy fails loudly instead of silently signing nobody in.
 */

export const SESSION_COOKIE_NAME = "__Host-lullet_session";
/** A session lasts 30 days from login; logging in again rotates it. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A browser login link is valid for ten minutes and works once. */
export const LOGIN_LINK_TTL_SECONDS = 10 * 60;
/** Mini App init data older than this (by `auth_date`) is refused. */
export const INIT_DATA_MAX_AGE_SECONDS = 60 * 60;

const MIN_SECRET_LENGTH = 32;

/** An environment, as `process.env` or a plain object in tests. */
type Env = Readonly<Record<string, string | undefined>>;

function required(name: string, env: Env): string {
  const value = env[name]?.trim();
  if (!value)
    throw new Error(`${name} is not set. See the README section "Environment and secrets".`);
  return value;
}

/** Key for hashing session cookies and login tokens at rest (HMAC). Rotating it signs everyone out. */
export function getSessionSecret(env: Env = process.env): string {
  const secret = required("SESSION_SECRET", env);
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (try \`openssl rand -base64 48\`).`,
    );
  }
  return secret;
}

/** The bot token from BotFather; the key material for verifying Mini App init data. */
export function getBotToken(env: Env = process.env): string {
  return required("TELEGRAM_BOT_TOKEN", env);
}

/** Public origin of the app, used to build login links (no trailing slash). */
export function getAppUrl(env: Env = process.env): string {
  const configured = env.APP_URL?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") {
      throw new Error('APP_URL is not set. See the README section "Environment and secrets".');
    }
    return "http://localhost:3000";
  }
  const url = new URL(configured);
  return url.origin + url.pathname.replace(/\/+$/, "");
}
