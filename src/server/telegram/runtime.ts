import { after } from "next/server";
import { getDatabase } from "@/db/client";
import { FrankfurterClient, type FxRateClient } from "@/lib/fx";
import { dailyUploadLimit } from "@/lib/import/policy";
import { getExtractor } from "@/server/import/extract";
import { getStorage } from "@/server/import/storage";
import { createGrammyApi, describeFailure } from "./api";
import { processUpdate, type BotDeps } from "./bot";
import { loadBotConfig } from "./config";
import { createNotifier, noopNotifier, type Notifier } from "./notify";
import type { WebhookRuntime } from "./webhook";

/** Wires the bot to the running app: environment, database, storage, model and Next's `after`. */

const globalForBot = globalThis as unknown as {
  __lulletFx?: FxRateClient;
  __lulletBotDeps?: BotDeps;
};

function fx(): FxRateClient {
  globalForBot.__lulletFx ??= new FrankfurterClient();
  return globalForBot.__lulletFx;
}

/** Runs work after the response is sent; the host keeps the function alive until it finishes. */
export function deferAfterResponse(task: () => Promise<unknown>): void {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("Deferred Telegram work failed", describeFailure(error));
    }
  });
}

function buildDeps(): BotDeps | null {
  const config = loadBotConfig();
  if (!config) return null;
  const db = getDatabase().db;
  const api = createGrammyApi(config);
  return {
    config,
    api,
    db,
    fx: fx(),
    storage: getStorage(),
    extractor: getExtractor(),
    dailyLimit: dailyUploadLimit(process.env.IMPORT_DAILY_LIMIT),
    notifier: createNotifier({ db, api, config }),
    now: () => new Date(),
  };
}

/** Built once per process, so the bot's username is asked of Telegram at most once. */
function botDeps(): BotDeps | null {
  globalForBot.__lulletBotDeps ??= buildDeps() ?? undefined;
  return globalForBot.__lulletBotDeps ?? null;
}

export function getWebhookRuntime(): WebhookRuntime {
  const deps = botDeps();
  return {
    config: deps?.config ?? null,
    defer: deferAfterResponse,
    process: (update) => (deps ? processUpdate(deps, update) : Promise.resolve()),
  };
}

/** The notifier for web actions and routes; does nothing until the bot is configured. */
export function getNotifier(): Notifier {
  return botDeps()?.notifier ?? noopNotifier;
}

/** Tells the group or members about a ledger change once the response has gone out. */
export function notifyAfterResponse(send: (notifier: Notifier) => Promise<void>): void {
  deferAfterResponse(() => send(getNotifier()));
}
