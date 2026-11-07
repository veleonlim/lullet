import { defineConfig, devices } from "@playwright/test";

try {
  // Local runs pick DATABASE_URL up from .env, like `next dev` does.
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

const port = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${port}`;
const isCI = Boolean(process.env.CI);

// The end to end suite has its own database (created and migrated by tests/e2e/global-setup.ts)
// on the same server as DATABASE_URL, and its own secrets. No real Telegram bot is involved:
// tests sign their own Mini App init data with this made-up token.
const adminDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://lullet:lullet@localhost:5432/lullet";
const e2eDatabaseUrl = new URL(adminDatabaseUrl);
e2eDatabaseUrl.pathname = "/lullet_e2e";
process.env.E2E_ADMIN_DATABASE_URL = adminDatabaseUrl;
process.env.E2E_DATABASE_URL = e2eDatabaseUrl.toString();
process.env.SESSION_SECRET = "e2e-session-secret-0123456789abcdefghijklmnop";
process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-bot-token-for-lullet-tests-only";
process.env.APP_URL = baseURL;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // All tests share one database and one signed-in member, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    // Both projects run on Chromium; "phone" emulates a Pixel 7 viewport, touch and user agent.
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // CI builds first (see the workflow) and serves the production build.
    command: isCI ? "pnpm start" : "pnpm dev",
    url: baseURL,
    env: {
      PORT: String(port),
      // The development sign-in stand-in: signs everyone in as the first seeded member.
      LULLET_DEV_AUTH: "1",
      LULLET_E2E: "1",
    },
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
