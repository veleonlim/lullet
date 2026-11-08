import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeTelegram } from "@/test-support/fake-telegram";
import { BOT_COMMANDS } from "./setup";
import { runSetupCli, SETUP_USAGE } from "./setup-cli";

const TOKEN = "123456:TEST-bot-token-for-lullet-tests-only";
const SECRET = "test-webhook-secret-0123456789abcdef";
const fake = new FakeTelegram(TOKEN);
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
});

const env = (over: Record<string, string | undefined> = {}) => ({
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
  APP_URL: "https://lullet.example.com",
  TELEGRAM_API_ROOT: fake.url,
  ...over,
});

async function run(argv: string[], environment: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSetupCli(argv, environment, {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("telegram:setup", () => {
  it("registers the webhook with its secret, the commands and the Mini App button", async () => {
    const { code, out, err } = await run([], env());
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Bot:            @lullet_test_bot");
    expect(out).toContain("https://lullet.example.com/api/telegram/webhook");
    expect(fake.callsTo("getMe")).toHaveLength(1);
    expect(fake.callsTo("setWebhook")[0]?.params).toEqual({
      url: "https://lullet.example.com/api/telegram/webhook",
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
    });
    expect(fake.callsTo("setMyCommands")[0]?.params.commands).toHaveLength(BOT_COMMANDS.length);
    expect(fake.callsTo("setChatMenuButton")[0]?.params.menu_button).toEqual({
      type: "web_app",
      text: "Open lullet",
      web_app: { url: "https://lullet.example.com/signin" },
    });
  });

  it("is safe to run again: the second run sends the same state and drops nothing", async () => {
    await run([], env());
    const first = fake.calls.map((call) => JSON.stringify(call));
    fake.calls.length = 0;
    const again = await run([], env());
    expect(again.code).toBe(0);
    expect(fake.calls.map((call) => JSON.stringify(call))).toEqual(first);
    expect(JSON.stringify(fake.callsTo("setWebhook")[0]?.params)).not.toContain("drop_pending");
  });

  it("never prints the bot token or the webhook secret", async () => {
    const { out, err } = await run([], env());
    for (const text of [out, err]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
    }
  });

  it("takes the public address from --url in place of APP_URL", async () => {
    const { code } = await run(["--url", "https://other.example.org"], env({ APP_URL: undefined }));
    expect(code).toBe(0);
    expect(fake.callsTo("setWebhook")[0]?.params.url).toBe(
      "https://other.example.org/api/telegram/webhook",
    );
  });

  it("calls nothing in a dry run, even for an address Telegram would refuse", async () => {
    const dry = await run(["--dry-run"], env({ APP_URL: "http://localhost:3000" }));
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("APP_URL must be a public https address");
    expect(fake.calls).toEqual([]);
  });

  it("refuses a non-https address before calling Telegram", async () => {
    const { code, err } = await run([], env({ APP_URL: "http://localhost:3000" }));
    expect(code).toBe(1);
    expect(err).toContain("https");
    expect(fake.calls).toEqual([]);
  });

  it("names the missing settings without calling Telegram", async () => {
    const { code, err } = await run(
      [],
      env({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_GROUP_CHAT_ID: " " }),
    );
    expect(code).toBe(1);
    expect(err).toContain("TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_CHAT_ID");
    expect(fake.calls).toEqual([]);
  });

  it("explains a malformed secret or address", async () => {
    const weak = await run([], env({ TELEGRAM_WEBHOOK_SECRET: "short" }));
    expect(weak.code).toBe(1);
    expect(weak.err).toContain("TELEGRAM_WEBHOOK_SECRET must be at least 16 characters");
    expect(weak.err).not.toContain("short\n");
    const bad = await run(["--url", "not a url"], env());
    expect(bad.code).toBe(1);
    expect(bad.err).not.toBe("");
    expect(fake.calls).toEqual([]);
  });

  it("tells the owner when Telegram rejects the token, without echoing it", async () => {
    const { code, err } = await run(
      [],
      env({ TELEGRAM_BOT_TOKEN: "999999:wrong-token-wrong-token-wrong" }),
    );
    expect(code).toBe(1);
    expect(err).toContain("Telegram rejected the bot token");
    expect(err).not.toContain("wrong-token");
    expect(fake.callsTo("setWebhook")).toEqual([]);
  });

  it("reports an unreachable Bot API as such", async () => {
    const { code, err } = await run([], env({ TELEGRAM_API_ROOT: "http://127.0.0.1:1" }));
    expect(code).toBe(1);
    expect(err).toContain("Telegram setup failed: telegram unreachable");
    expect(err).not.toContain(TOKEN);
  });

  it("prints Telegram's last delivery error when there is one", async () => {
    const result = await withErroringBotApi((root) => run([], env({ TELEGRAM_API_ROOT: root })));
    expect(result.code).toBe(0);
    expect(result.out).toContain("3 pending updates");
    expect(result.err).toContain("Telegram's last delivery error: Wrong response from the webhook");
  });

  it("shows usage for --help and for an unknown flag", async () => {
    const help = await run(["--help"], env());
    expect(help.code).toBe(0);
    expect(help.out).toBe(SETUP_USAGE);
    const unknown = await run(["--frobnicate"], env());
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe(SETUP_USAGE);
    expect(fake.calls).toEqual([]);
  });
});

/** A one-off Bot API that reports a delivery error, since the shared fake always reports none. */
async function withErroringBotApi<T>(task: (root: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const method = request.url?.split("/").pop() ?? "";
    const result: Record<string, unknown> = {
      getMe: { id: 1, is_bot: true, first_name: "x", username: "lullet_test_bot" },
      getWebhookInfo: {
        url: "https://lullet.example.com/api/telegram/webhook",
        pending_update_count: 3,
        has_custom_certificate: false,
        last_error_message: "Wrong response from the webhook",
      },
    };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, result: result[method] ?? true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await task(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
