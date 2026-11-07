import { defineConfig, devices } from "@playwright/test";

// A dedicated port, so a `pnpm dev` server on 3000 is never mistaken for the test server.
const port = Number(process.env.PORT ?? 3100);
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
  // The ledger tests share one group and empty its ledger before each test, so they run one at a time.
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
      DATABASE_URL: e2eDatabaseUrl.toString(),
      SESSION_SECRET: process.env.SESSION_SECRET,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      APP_URL: baseURL,
      LULLET_DEV_AUTH: "1",
    },
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
