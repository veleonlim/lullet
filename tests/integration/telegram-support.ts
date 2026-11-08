import type { Update } from "grammy/types";
import type { Database } from "@/db/client";
import { bootstrapGroup } from "@/lib/auth/db/members";
import { createGrammyApi } from "@/server/telegram/api";
import { processUpdate, type BotDeps } from "@/server/telegram/bot";
import type { BotConfig } from "@/server/telegram/config";
import { createNotifier } from "@/server/telegram/notify";
import { type FakeTelegram, type FakeMessage } from "@/test-support/fake-telegram";
import { makePng } from "@/test-support/images";
import {
  callbackUpdate,
  photoUpdate,
  textUpdate,
  type Where,
} from "@/test-support/telegram-updates";
import { FakeFx, RATES } from "./ledger-support";
import { MemoryStorage, ScriptedExtractor } from "./import-support";
import { TEST_SECRET } from "./helpers";

export const BOT_TOKEN = "123456:TEST-bot-token-for-lullet-tests-only";
export const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";
export const GROUP_CHAT = -1001234567890;
export const APP_URL = "https://lullet.test";

export const PEOPLE = [
  { name: "Alex", telegramId: 1001 },
  { name: "Mei", telegramId: 1002 },
  { name: "Mum", telegramId: 1003 },
  { name: "Dad", telegramId: 1004 },
] as const;

export interface BotWorld {
  readonly fake: FakeTelegram;
  readonly deps: BotDeps;
  readonly config: BotConfig;
  readonly groupId: string;
  readonly userIds: readonly string[];
  readonly storage: MemoryStorage;
  readonly extractor: ScriptedExtractor;
  readonly clock: { now: Date };
  send(update: Update): ReturnType<typeof processUpdate>;
  /** `index` is the member (0 = Alex). Sends a photo in their private chat, or in the group. */
  photo(
    index: number,
    options?: { caption?: string; group?: boolean; seed?: number; size?: number },
  ): Promise<void>;
  say(
    index: number,
    text: string,
    options?: { group?: boolean; replyTo?: number },
  ): ReturnType<typeof processUpdate>;
  tap(index: number, message: FakeMessage, label: string): ReturnType<typeof processUpdate>;
  /** The member's private chat with the bot. */
  where(index: number, group?: boolean): Where;
  draftMessage(index: number): FakeMessage;
}

export async function setupBotWorld(
  db: Database,
  fake: FakeTelegram,
  options: { readonly dailyLimit?: number } = {},
): Promise<BotWorld> {
  const { groupId, userIds } = await bootstrapGroup(
    {
      groupName: "Switzerland and Italy",
      members: PEOPLE.map((p) => ({ displayName: p.name, telegramUserId: p.telegramId })),
    },
    { db, secret: TEST_SECRET },
  );
  const config: BotConfig = {
    token: BOT_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
    groupChatId: GROUP_CHAT,
    apiRoot: fake.url,
    botUsername: null,
    appUrl: APP_URL,
  };
  const api = createGrammyApi(config);
  const clock = { now: new Date("2026-11-08T10:00:00Z") };
  const storage = new MemoryStorage();
  const extractor = new ScriptedExtractor();
  const deps: BotDeps = {
    config,
    api,
    db,
    fx: new FakeFx(RATES),
    storage,
    extractor,
    dailyLimit: options.dailyLimit ?? 30,
    notifier: createNotifier({ db, api, config }),
    now: () => clock.now,
    sessionSecret: TEST_SECRET,
  };
  let photos = 0;
  const where = (index: number, group = false): Where => {
    const person = PEOPLE[index];
    if (!person) throw new Error("no such member");
    return group
      ? {
          fromId: person.telegramId,
          chatId: GROUP_CHAT,
          chatType: "supergroup",
          firstName: person.name,
        }
      : {
          fromId: person.telegramId,
          chatId: person.telegramId,
          chatType: "private",
          firstName: person.name,
        };
  };
  const world: BotWorld = {
    fake,
    deps,
    config,
    groupId,
    userIds,
    storage,
    extractor,
    clock,
    send: (update) => processUpdate(deps, update),
    async photo(index, options = {}) {
      photos += 1;
      const fileId = `photo-${String(photos)}`;
      fake.addFile(fileId, makePng({ seed: options.seed ?? photos }));
      await world.send(
        photoUpdate(where(index, options.group), {
          fileId,
          ...(options.caption === undefined ? {} : { caption: options.caption }),
          ...(options.size === undefined ? {} : { size: options.size }),
        }),
      );
    },
    say: (index, text, options = {}) =>
      world.send(
        textUpdate(
          where(index, options.group),
          text,
          options.replyTo === undefined ? {} : { replyTo: options.replyTo },
        ),
      ),
    tap: (index, message, label) =>
      world.send(
        callbackUpdate(where(index), {
          messageId: message.messageId,
          data: fake.callbackFor(message, label),
        }),
      ),
    where,
    draftMessage: (index) => fake.lastTo(PEOPLE[index]?.telegramId ?? 0),
  };
  return world;
}
