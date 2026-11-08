import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeTelegram } from "@/test-support/fake-telegram";
import { BOT_COMMANDS, buildSetupPlan, runSetup, setupProblem } from "./setup";
import type { BotConfig } from "./config";

const fake = new FakeTelegram("1:tok");
beforeAll(() => fake.start());
afterAll(() => fake.stop());

const config = (over: Partial<BotConfig> = {}): BotConfig => ({
  token: "1:tok",
  webhookSecret: "secret-secret-secret-1234",
  groupChatId: -100,
  apiRoot: fake.url,
  botUsername: null,
  appUrl: "https://lullet.example.com",
  ...over,
});

describe("registering the bot", () => {
  it("plans the webhook, the Mini App address and the commands", () => {
    const plan = buildSetupPlan(config());
    expect(plan.webhookUrl).toBe("https://lullet.example.com/api/telegram/webhook");
    expect(plan.miniAppUrl).toBe("https://lullet.example.com/signin");
    expect(plan.commands).toBe(BOT_COMMANDS);
    expect(plan.commands.map((c) => c.command)).toEqual([
      "import",
      "rate",
      "login",
      "alias",
      "help",
    ]);
    expect(plan.allowedUpdates).toEqual(["message", "callback_query"]);
    expect(setupProblem(plan)).toBeNull();
    expect(setupProblem(buildSetupPlan(config({ appUrl: "http://localhost:3000" })))).toContain(
      "https",
    );
  });

  it("registers the webhook with its secret token, the commands and the menu button", async () => {
    fake.reset();
    const result = await runSetup(config(), buildSetupPlan(config()));
    expect(result).toEqual({
      botUsername: "lullet_test_bot",
      webhookUrl: "https://lullet.example.com/api/telegram/webhook",
      pendingUpdates: 0,
      lastError: null,
    });
    expect(fake.callsTo("setWebhook")[0]?.params).toEqual({
      url: "https://lullet.example.com/api/telegram/webhook",
      secret_token: "secret-secret-secret-1234",
      allowed_updates: ["message", "callback_query"],
    });
    expect(fake.callsTo("setMyCommands")[0]?.params.commands).toHaveLength(BOT_COMMANDS.length);
    expect(fake.callsTo("setChatMenuButton")[0]?.params.menu_button).toEqual({
      type: "web_app",
      text: "Open lullet",
      web_app: { url: "https://lullet.example.com/signin" },
    });
  });
});
