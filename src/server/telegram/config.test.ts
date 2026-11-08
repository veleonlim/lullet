import { describe, expect, it } from "vitest";
import { DEFAULT_API_ROOT, loadBotConfig } from "./config";

const env = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "secret-secret-secret-1234",
  TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
  APP_URL: "https://lullet.example.com/",
};

describe("bot configuration", () => {
  it("reads everything from the environment", () => {
    expect(loadBotConfig({ ...env, TELEGRAM_BOT_USERNAME: "@lullet_bot" })).toEqual({
      token: "123:abc",
      webhookSecret: "secret-secret-secret-1234",
      groupChatId: -1001234567890,
      apiRoot: DEFAULT_API_ROOT,
      botUsername: "lullet_bot",
      appUrl: "https://lullet.example.com",
    });
    expect(loadBotConfig({ ...env, TELEGRAM_API_ROOT: "http://127.0.0.1:9" })?.apiRoot).toBe(
      "http://127.0.0.1:9",
    );
  });

  it("is not configured until the token, the secret and the group are all set", () => {
    expect(loadBotConfig({})).toBeNull();
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_GROUP_CHAT_ID"]) {
      expect(loadBotConfig({ ...env, [key]: " " })).toBeNull();
      expect(loadBotConfig({ ...env, [key]: undefined })).toBeNull();
    }
  });

  it("fails loudly on a secret Telegram would refuse or a group id that is not a number", () => {
    expect(() => loadBotConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow(
      "at least 16",
    );
    expect(() =>
      loadBotConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: "has spaces in it 1234567" }),
    ).toThrow();
    expect(() => loadBotConfig({ ...env, TELEGRAM_GROUP_CHAT_ID: "abc" })).toThrow(
      "numeric chat id",
    );
    expect(() => loadBotConfig({ ...env, TELEGRAM_GROUP_CHAT_ID: "0" })).toThrow();
  });
});
