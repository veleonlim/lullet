import path from "node:path";
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
// E2E_DATABASE_NAME lets two checkouts on one machine run the suite at the same time.
const e2eDatabaseName = process.env.E2E_DATABASE_NAME ?? "lullet_e2e";
const e2eDatabaseUrl = new URL(adminDatabaseUrl);
e2eDatabaseUrl.pathname = `/${e2eDatabaseName}`;
process.env.E2E_ADMIN_DATABASE_URL = adminDatabaseUrl;
process.env.E2E_DATABASE_URL = e2eDatabaseUrl.toString();
process.env.E2E_DATABASE_NAME = e2eDatabaseName;
process.env.SESSION_SECRET = "e2e-session-secret-0123456789abcdefghijklmnop";
process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-bot-token-for-lullet-tests-only";
process.env.APP_URL = baseURL;

// Screenshot import: the model is replaced by canned answers (one JSON file per image hash, written
// by the tests) and originals are kept in a local folder. Nothing here calls Claude or Cloudflare.
const e2eDataDir = path.resolve(".data", "e2e", String(port));
process.env.E2E_STUB_DIR = path.join(e2eDataDir, "stub");
process.env.E2E_STORAGE_DIR = path.join(e2eDataDir, "screenshots");
process.env.E2E_CRON_SECRET = "e2e-cron-secret-0123456789";

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
      LULLET_EXTRACTOR: "stub",
      LULLET_STUB_DIR: process.env.E2E_STUB_DIR,
      LULLET_STORAGE: "local",
      LULLET_STORAGE_DIR: process.env.E2E_STORAGE_DIR,
      CRON_SECRET: process.env.E2E_CRON_SECRET,
    },
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
