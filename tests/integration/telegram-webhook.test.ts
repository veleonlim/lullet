import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SECRET_HEADER } from "@/lib/telegram/secret";
import { processUpdate } from "@/server/telegram/bot";
import { handleWebhook, type WebhookRuntime } from "@/server/telegram/webhook";
import { FakeTelegram } from "@/test-support/fake-telegram";
import { textUpdate } from "@/test-support/telegram-updates";
import { closeTestDb, resetDatabase, testDb } from "./helpers";
import {
  BOT_TOKEN,
  PEOPLE,
  WEBHOOK_SECRET,
  setupBotWorld,
  type BotWorld,
} from "./telegram-support";

const db = testDb();
const fake = new FakeTelegram(BOT_TOKEN);
let world: BotWorld;
let pending: Promise<unknown>[];
let runtime: WebhookRuntime;

beforeAll(() => fake.start());
afterAll(async () => {
  await fake.stop();
  await closeTestDb();
});
beforeEach(async () => {
  fake.reset();
  await resetDatabase(db);
  world = await setupBotWorld(db, fake);
  pending = [];
  runtime = {
    config: world.config,
    defer: (task) => pending.push(task()),
    process: (update) => processUpdate(world.deps, update),
  };
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());
const warnings = () => warn.mock.calls.map((call) => String(call[0]));

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://lullet.test/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const update = () => textUpdate(world.where(0), "/help");

describe("the webhook", () => {
  it("accepts an update with the right secret, answers at once and does the work afterwards", async () => {
    const response = await handleWebhook(
      post(update(), { [SECRET_HEADER]: WEBHOOK_SECRET }),
      runtime,
    );
    expect(response.status).toBe(200);
    // Nothing has been sent yet: the work was handed to the after-response hook.
    expect(fake.callsTo("sendMessage")).toHaveLength(0);
    await Promise.all(pending);
    expect(fake.lastTo(PEOPLE[0].telegramId).text).toContain("/rate EUR 1.51");
  });

  it.each([
    ["no secret", {}],
    ["a wrong secret", { [SECRET_HEADER]: "wrong-secret-0123456789abcdef" }],
    ["a secret of another length", { [SECRET_HEADER]: "x" }],
    ["an empty secret", { [SECRET_HEADER]: "" }],
  ])("refuses %s and does nothing", async (_label, headers) => {
    const response = await handleWebhook(post(update(), headers), runtime);
    expect(response.status).toBe(401);
    expect(pending).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("refused with 401");
    expect(warnings()[0]).not.toContain(WEBHOOK_SECRET);
    expect(warnings()[0]).not.toContain("wrong-secret");
  });

  it("says in the log whether the secret header was missing or did not match", async () => {
    await handleWebhook(post(update()), runtime);
    await handleWebhook(
      post(update(), { [SECRET_HEADER]: "wrong-secret-0123456789abcdef" }),
      runtime,
    );
    expect(warnings()).toEqual([
      "Telegram webhook refused with 401: the secret token header is missing",
      "Telegram webhook refused with 401: the secret token does not match TELEGRAM_WEBHOOK_SECRET",
    ]);
  });

  it("pretends not to exist until the bot is configured", async () => {
    const response = await handleWebhook(post(update(), { [SECRET_HEADER]: WEBHOOK_SECRET }), {
      ...runtime,
      config: null,
    });
    expect(response.status).toBe(404);
    expect(warnings()).toEqual([
      "Telegram webhook refused with 404: the bot is not configured (token, webhook secret or group id)",
    ]);
  });

  it("refuses bodies that are not Telegram updates", async () => {
    const headers = { [SECRET_HEADER]: WEBHOOK_SECRET };
    expect((await handleWebhook(post("not json", headers), runtime)).status).toBe(400);
    expect((await handleWebhook(post({ message: {} }, headers), runtime)).status).toBe(400);
    expect((await handleWebhook(post({ update_id: -1 }, headers), runtime)).status).toBe(400);
    const huge = post("x".repeat(1_100_000), { ...headers, "content-length": "1100000" });
    expect((await handleWebhook(huge, runtime)).status).toBe(413);
    expect(pending).toHaveLength(0);
    expect(warnings()).toEqual([
      "Telegram webhook refused with 400: the body is not valid JSON",
      "Telegram webhook refused with 400: the body is not a Telegram update",
      "Telegram webhook refused with 400: the body is not a Telegram update",
      "Telegram webhook refused with 413: the declared body is too large",
    ]);
  });

  it("answers 200 even when processing fails, so Telegram does not redeliver forever", async () => {
    const failing: WebhookRuntime = {
      ...runtime,
      process: () => Promise.reject(new Error("boom")),
    };
    const response = await handleWebhook(
      post(update(), { [SECRET_HEADER]: WEBHOOK_SECRET }),
      failing,
    );
    expect(response.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
