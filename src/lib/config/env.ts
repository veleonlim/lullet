/**
 * Every environment variable lullet reads, in one place. docs/ENVIRONMENT.md is the human
 * readable version of this table (a unit test keeps the two in step), and `checkProductionEnv`
 * is the start-up check that turns a missing or malformed production value into one clear message.
 *
 * Secrets are never echoed: a problem names the variable and what is wrong, never its value.
 */

type Env = Readonly<Record<string, string | undefined>>;

export type EnvRequirement =
  /** The production server refuses to start without it. */
  | "required"
  /** Has a safe default or turns a feature off. Validated when present. */
  | "optional"
  /** Only for tests and local development. Must not be set in production. */
  | "test-only";

export interface EnvVariable {
  readonly name: string;
  /** Where the value comes from, in words the owner can follow. */
  readonly source: string;
  readonly requirement: EnvRequirement;
  /** A made-up value of the right shape. */
  readonly example: string;
  /** Returns what is wrong with a non-empty value, or null when it is fine. */
  readonly validate?: (value: string) => string | null;
}

const MIN_SESSION_SECRET = 32;
const MIN_SHARED_SECRET = 16;

const positiveInteger = (value: string): string | null =>
  /^[1-9]\d*$/.test(value) ? null : "must be a positive whole number";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function postgresUrl(value: string): string | null {
  const url = parseUrl(value);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || url.hostname === "") {
    return "must be a connection string starting with postgres:// or postgresql://";
  }
  return null;
}

function httpsOrigin(value: string): string | null {
  const url = parseUrl(value);
  if (url?.protocol !== "https:") return "must be a public https address";
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "must be the public address, not localhost";
  }
  return null;
}

export const ENV_VARIABLES: readonly EnvVariable[] = [
  {
    name: "DATABASE_URL",
    source: "Neon: connection string with the pooler switched ON",
    requirement: "required",
    example:
      "postgresql://user:pass@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    validate: postgresUrl,
  },
  {
    name: "DATABASE_URL_UNPOOLED",
    source: "Neon: connection string with the pooler switched OFF (used only for migrations)",
    requirement: "optional",
    example:
      "postgresql://user:pass@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    validate: postgresUrl,
  },
  {
    name: "DATABASE_POOL_MAX",
    source: "You choose; connections per server instance, default 5 (use 1 on Vercel)",
    requirement: "optional",
    example: "1",
    validate: positiveInteger,
  },
  {
    name: "SESSION_SECRET",
    source: "You generate it: openssl rand -base64 48",
    requirement: "required",
    example: "k3J9...at-least-32-random-characters...",
    validate: (value) => {
      if (value.length < MIN_SESSION_SECRET) {
        return `must be at least ${String(MIN_SESSION_SECRET)} characters (try \`openssl rand -base64 48\`)`;
      }
      return /change-me/i.test(value) ? "is still the example value from .env.example" : null;
    },
  },
  {
    name: "APP_URL",
    source: "Vercel: the public address of the deployment, no trailing slash",
    requirement: "required",
    example: "https://lullet.vercel.app",
    validate: httpsOrigin,
  },
  {
    name: "TELEGRAM_BOT_TOKEN",
    source: "BotFather: the token it gives you when the bot is created",
    requirement: "required",
    example: "123456789:AAH-example_token_from_BotFather_xyz",
    validate: (value) =>
      /^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(value)
        ? null
        : "does not look like a BotFather token (digits, a colon, then letters and digits)",
  },
  {
    name: "TELEGRAM_WEBHOOK_SECRET",
    source: "You generate it: openssl rand -hex 32",
    requirement: "required",
    example: "9f2c...64-hex-characters...",
    validate: (value) =>
      value.length >= MIN_SHARED_SECRET && /^[A-Za-z0-9_-]+$/.test(value)
        ? null
        : `must be at least ${String(MIN_SHARED_SECRET)} characters of A-Z, a-z, 0-9, _ or - (try \`openssl rand -hex 32\`)`,
  },
  {
    name: "TELEGRAM_GROUP_CHAT_ID",
    source: "Telegram: the numeric id of the family group chat (usually negative)",
    requirement: "required",
    example: "-1001234567890",
    validate: (value) =>
      /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) !== 0
        ? null
        : "must be the group's numeric chat id, for example -1001234567890",
  },
  {
    name: "TELEGRAM_BOT_USERNAME",
    source: "BotFather: the bot's username; optional, saves one lookup",
    requirement: "optional",
    example: "lullet_family_bot",
    validate: (value) =>
      /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value) ? null : "does not look like a bot username",
  },
  {
    name: "ANTHROPIC_API_KEY",
    source: "Claude Console: an API key (console.anthropic.com)",
    requirement: "required",
    example: "sk-ant-api03-...",
    validate: (value) => (value.startsWith("sk-ant-") ? null : "should start with sk-ant-"),
  },
  {
    name: "S3_ENDPOINT",
    source: "Optional. Cloudflare R2: the S3 API address of your account",
    requirement: "optional",
    example: "https://0123456789abcdef.r2.cloudflarestorage.com",
    validate: (value) => {
      const url = parseUrl(value);
      return url?.protocol === "https:" && url.pathname === "/"
        ? null
        : "must be the account's https address with no bucket name or path in it";
    },
  },
  {
    name: "S3_BUCKET",
    source: "Optional. Cloudflare R2: the bucket name",
    requirement: "optional",
    example: "lullet-screenshots",
    validate: (value) =>
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)
        ? null
        : "must be a bucket name: 3 to 63 lowercase letters, digits or hyphens",
  },
  {
    name: "S3_ACCESS_KEY_ID",
    source: "Optional. Cloudflare R2: the API token's Access Key ID",
    requirement: "optional",
    example: "0123456789abcdef0123456789abcdef",
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    source: "Optional. Cloudflare R2: the API token's Secret Access Key (shown once)",
    requirement: "optional",
    example: "0123...64-hex-characters...",
  },
  {
    name: "CRON_SECRET",
    source: "You generate it: openssl rand -hex 32. Vercel sends it to the scheduled clean-up",
    requirement: "required",
    example: "5d1e...64-hex-characters...",
    validate: (value) =>
      value.length >= MIN_SHARED_SECRET
        ? null
        : `must be at least ${String(MIN_SHARED_SECRET)} characters (try \`openssl rand -hex 32\`)`,
  },
  {
    name: "IMPORT_DAILY_LIMIT",
    source: "You choose; screenshot uploads per person per rolling day, default 30",
    requirement: "optional",
    example: "30",
    validate: positiveInteger,
  },
  {
    name: "LULLET_STORAGE_DIR",
    source: "Development only; folder for screenshots when they are not kept in the database",
    requirement: "test-only",
    example: ".data/screenshots",
  },
  {
    name: "LULLET_STORAGE",
    source:
      "Tests only; local to allow folder storage in a production build, postgres to keep screenshots in the database outside production",
    requirement: "test-only",
    example: "local",
    validate: (value) => (value === "local" ? "must not be set in production" : null),
  },
  {
    name: "LULLET_EXTRACTOR",
    source: "Tests only; stub answers from canned files instead of calling Claude",
    requirement: "test-only",
    example: "stub",
    validate: (value) => (value === "stub" ? "must not be set in production" : null),
  },
  {
    name: "LULLET_STUB_DIR",
    source: "Tests only; folder of canned answers for LULLET_EXTRACTOR=stub",
    requirement: "test-only",
    example: ".data/stub-extractions",
  },
  {
    name: "TELEGRAM_API_ROOT",
    source: "Tests only; a fake Bot API server instead of api.telegram.org",
    requirement: "test-only",
    example: "http://127.0.0.1:4011",
    validate: () => "must not be set in production",
  },
  {
    name: "LULLET_SKIP_ENV_CHECK",
    source: "Tests only; switches this start-up check off for the end to end suite",
    requirement: "test-only",
    example: "1",
    validate: () => "must not be set in production",
  },
];

/** Screenshots go to R2 only when all four are set; otherwise they stay in the database. */
const S3_VARIABLES = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

export interface EnvProblem {
  readonly name: string;
  readonly message: string;
}

/** Everything wrong with a production environment. Empty when it is ready to run. */
export function checkProductionEnv(env: Env): EnvProblem[] {
  const problems: EnvProblem[] = [];
  for (const variable of ENV_VARIABLES) {
    const value = env[variable.name]?.trim() ?? "";
    if (value === "") {
      if (variable.requirement === "required") {
        problems.push({ name: variable.name, message: `is not set (${variable.source})` });
      }
      continue;
    }
    const problem = variable.validate?.(value) ?? null;
    if (problem) problems.push({ name: variable.name, message: problem });
  }
  // Half an R2 setup would silently fall back to the database, which is not what was meant.
  const unsetS3 = S3_VARIABLES.filter((name) => (env[name]?.trim() ?? "") === "");
  if (unsetS3.length > 0 && unsetS3.length < S3_VARIABLES.length) {
    for (const name of unsetS3) {
      problems.push({
        name,
        message:
          "is not set (the four S3_* variables for Cloudflare R2 go together: set all or none; with none, screenshots are kept briefly in the database)",
      });
    }
  }
  return problems;
}

export class EnvConfigError extends Error {
  readonly problems: readonly EnvProblem[];

  constructor(problems: readonly EnvProblem[]) {
    super(formatEnvProblems(problems));
    this.name = "EnvConfigError";
    this.problems = problems;
  }
}

export function formatEnvProblems(problems: readonly EnvProblem[]): string {
  const lines = problems.map((problem) => `  - ${problem.name} ${problem.message}`);
  return [
    "lullet cannot start: the production settings are incomplete or wrong.",
    ...lines,
    "See docs/ENVIRONMENT.md for what each one is and where to copy it from.",
  ].join("\n");
}

/** Throws one error naming every problem, or returns when the environment is ready. */
export function assertProductionEnv(env: Env): void {
  const problems = checkProductionEnv(env);
  if (problems.length > 0) throw new EnvConfigError(problems);
}
