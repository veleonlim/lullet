import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
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
    env: { PORT: String(port) },
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
