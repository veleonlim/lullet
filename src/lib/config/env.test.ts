import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENV_VARIABLES,
  EnvConfigError,
  assertProductionEnv,
  checkProductionEnv,
  formatEnvProblems,
} from "./env";

/** A complete, valid production environment made of obviously fake values. */
const GOOD: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  SESSION_SECRET: "a".repeat(40),
  APP_URL: "https://lullet.example.com",
  TELEGRAM_BOT_TOKEN: "123456789:AAH-example_token_from_BotFather_xyz",
  TELEGRAM_WEBHOOK_SECRET: "b".repeat(32),
  TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
  ANTHROPIC_API_KEY: "sk-ant-api03-fake",
  S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
  S3_BUCKET: "lullet-screenshots",
  S3_ACCESS_KEY_ID: "access",
  S3_SECRET_ACCESS_KEY: "secret",
  CRON_SECRET: "c".repeat(32),
};

const names = (env: Record<string, string | undefined>) =>
  checkProductionEnv(env).map((problem) => problem.name);

describe("checkProductionEnv", () => {
  it("accepts a complete environment", () => {
    expect(checkProductionEnv(GOOD)).toEqual([]);
    expect(() => {
      assertProductionEnv(GOOD);
    }).not.toThrow();
  });

  it("accepts the optional values when they are well formed", () => {
    const env = {
      ...GOOD,
      DATABASE_URL_UNPOOLED: "postgres://u:p@ep-x.neon.tech/neondb",
      DATABASE_POOL_MAX: "1",
      TELEGRAM_BOT_USERNAME: "@lullet_family_bot",
      IMPORT_DAILY_LIMIT: "30",
      LULLET_STORAGE_DIR: ".data/screenshots",
    };
    expect(checkProductionEnv(env)).toEqual([]);
  });

  it("reports every missing required variable at once, blank values included", () => {
    expect(names({})).toEqual(
      ENV_VARIABLES.filter((variable) => variable.requirement === "required").map((v) => v.name),
    );
    expect(names({ ...GOOD, SESSION_SECRET: "   ", CRON_SECRET: undefined })).toEqual([
      "SESSION_SECRET",
      "CRON_SECRET",
    ]);
  });

  it.each([
    ["DATABASE_URL", "mysql://u:p@host/db"],
    ["DATABASE_URL", "not a url"],
    ["DATABASE_URL_UNPOOLED", "http://host"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "two"],
    ["SESSION_SECRET", "too-short"],
    ["SESSION_SECRET", "local-development-secret-change-me-0123456789"],
    ["APP_URL", "http://lullet.example.com"],
    ["APP_URL", "https://localhost:3000"],
    ["APP_URL", "lullet.example.com"],
    ["TELEGRAM_BOT_TOKEN", "not-a-token"],
    ["TELEGRAM_WEBHOOK_SECRET", "short"],
    ["TELEGRAM_WEBHOOK_SECRET", "has spaces and is long enough to pass the length"],
    ["TELEGRAM_GROUP_CHAT_ID", "my-group"],
    ["TELEGRAM_GROUP_CHAT_ID", "0"],
    ["TELEGRAM_BOT_USERNAME", "no spaces allowed"],
    ["ANTHROPIC_API_KEY", "wrong-prefix"],
    ["S3_ENDPOINT", "http://x.r2.cloudflarestorage.com"],
    ["S3_ENDPOINT", "https://x.r2.cloudflarestorage.com/my-bucket"],
    ["S3_BUCKET", "Bad_Bucket"],
    ["CRON_SECRET", "short"],
    ["IMPORT_DAILY_LIMIT", "-3"],
  ])("rejects a malformed %s (%s)", (name, value) => {
    expect(names({ ...GOOD, [name]: value })).toEqual([name]);
  });

  it("refuses the test-only switches in production", () => {
    for (const [name, value] of [
      ["LULLET_STORAGE", "local"],
      ["LULLET_EXTRACTOR", "stub"],
      ["TELEGRAM_API_ROOT", "http://127.0.0.1:4011"],
      ["LULLET_SKIP_ENV_CHECK", "1"],
    ] as const) {
      expect(names({ ...GOOD, [name]: value })).toEqual([name]);
    }
    expect(names({ ...GOOD, LULLET_STORAGE: "s3", LULLET_EXTRACTOR: "claude" })).toEqual([]);
  });
});

describe("the start-up error", () => {
  const secret = "the-actual-session-secret-value-must-never-appear-1234567890";

  it("names the variables and says where to look, without echoing any value", () => {
    const env = { ...GOOD, SESSION_SECRET: secret.slice(0, 10), APP_URL: "http://nope.example" };
    delete (env as Record<string, string | undefined>).CRON_SECRET;
    const error = (() => {
      try {
        assertProductionEnv(env);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(EnvConfigError);
    const message = (error as EnvConfigError).message;
    expect(message).toContain("lullet cannot start");
    expect(message).toContain("SESSION_SECRET must be at least 32 characters");
    expect(message).toContain("APP_URL must be a public https address");
    expect(message).toContain("CRON_SECRET is not set");
    expect(message).toContain("docs/ENVIRONMENT.md");
    for (const value of Object.values(env)) expect(message).not.toContain(value);
    expect((error as EnvConfigError).problems).toHaveLength(3);
    expect(formatEnvProblems([])).toContain("lullet cannot start");
  });
});

describe("the environment reference", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const reference = readFileSync(path.join(root, "docs/ENVIRONMENT.md"), "utf8");

  it("describes every variable in the table", () => {
    for (const variable of ENV_VARIABLES) {
      expect(reference, variable.name).toContain(`\`${variable.name}\``);
    }
  });

  it("lists every variable in .env.example too", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    for (const variable of ENV_VARIABLES) {
      expect(example, variable.name).toMatch(new RegExp(`^#? ?${variable.name}=`, "m"));
    }
  });

  it("covers every variable the code reads", () => {
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) sources.push(full);
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "scripts"));
    const used = new Set<string>();
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(/env\.([A-Z][A-Z0-9_]{3,})/g)) {
        used.add(match[1] ?? "");
      }
    }
    // Set by the host or the framework rather than configured by the owner.
    for (const hostVariable of ["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE"])
      used.delete(hostVariable);
    const documented = new Set(ENV_VARIABLES.map((variable) => variable.name));
    expect([...used].filter((name) => !documented.has(name))).toEqual([]);
  });
});
