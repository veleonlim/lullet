import { describe, expect, it } from "vitest";
import { getAppUrl, getBotToken, getSessionSecret } from "./config";

describe("auth config", () => {
  it("reads the session secret and insists on a long one", () => {
    expect(getSessionSecret({ SESSION_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
    expect(() => getSessionSecret({ SESSION_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => getSessionSecret({})).toThrow(/SESSION_SECRET is not set/);
    expect(() => getSessionSecret({ SESSION_SECRET: "   " })).toThrow(/not set/);
  });

  it("reads the bot token from the environment only", () => {
    expect(getBotToken({ TELEGRAM_BOT_TOKEN: " 1:abc " })).toBe("1:abc");
    expect(() => getBotToken({})).toThrow(/TELEGRAM_BOT_TOKEN is not set/);
  });

  it("normalises the app url and defaults to localhost outside production", () => {
    expect(getAppUrl({ APP_URL: "https://lullet.example/" })).toBe("https://lullet.example");
    expect(getAppUrl({ APP_URL: "https://lullet.example/app//" })).toBe(
      "https://lullet.example/app",
    );
    expect(getAppUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(() => getAppUrl({ NODE_ENV: "production" })).toThrow(/APP_URL is not set/);
  });
});
