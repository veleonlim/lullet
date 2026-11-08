import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  callbackUpdate,
  photoUpdate,
  textUpdate,
  type Where,
} from "@/test-support/telegram-updates";
import { classifyUpdate, mentionsBot, parseCommand, type BotScope } from "./routing";

const GROUP = -1001234;
const scope: BotScope = {
  groupChatId: GROUP,
  allowedUserIds: new Set([1, 2, 3, 4]),
  botUsername: "lullet_bot",
};
const dm = (id = 1): Where => ({ fromId: id, chatId: id, chatType: "private" });
const group = (id = 1): Where => ({ fromId: id, chatId: GROUP, chatType: "supergroup" });
const reason = (update: Update, s: BotScope = scope) => {
  const intent = classifyUpdate(update, s);
  return intent.kind === "ignore" ? intent.reason : intent.kind;
};

describe("the allowlist", () => {
  it("ignores unknown people everywhere", () => {
    expect(reason(textUpdate(dm(99), "/help"))).toBe("not_allowed");
    expect(reason(photoUpdate(dm(99), { fileId: "f" }))).toBe("not_allowed");
    expect(reason(textUpdate(group(99), "/help"))).toBe("not_allowed");
    expect(reason(callbackUpdate(dm(99), { messageId: 1, data: "x" }))).toBe("not_allowed");
  });

  it("ignores chats other than private chats and the one group", () => {
    expect(reason(textUpdate({ fromId: 1, chatId: -5, chatType: "supergroup" }, "/help"))).toBe(
      "wrong_chat",
    );
    expect(reason(textUpdate({ fromId: 1, chatId: GROUP, chatType: "channel" }, "/help"))).toBe(
      "wrong_chat",
    );
    // A "private" chat whose id is not the sender's own is not their chat with the bot.
    expect(reason(textUpdate({ fromId: 1, chatId: 2, chatType: "private" }, "/help"))).toBe(
      "wrong_chat",
    );
    expect(
      reason(
        callbackUpdate({ fromId: 1, chatId: -5, chatType: "group" }, { messageId: 1, data: "x" }),
      ),
    ).toBe("wrong_chat");
  });

  it("ignores other bots and anything that is not a message or a button tap", () => {
    expect(reason(textUpdate({ ...dm(1), isBot: true }, "/help"))).toBe("bot_sender");
    expect(reason(callbackUpdate({ ...dm(1), isBot: true }, { messageId: 1, data: "x" }))).toBe(
      "bot_sender",
    );
    expect(reason({ update_id: 1, edited_message: {} } as unknown as Update)).toBe(
      "unsupported_update",
    );
    expect(
      reason({
        update_id: 1,
        message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 },
      } as Update),
    ).toBe("not_allowed");
  });

  it("serves the group chat and private chats alike for allowlisted people", () => {
    expect(reason(textUpdate(dm(2), "/help"))).toBe("command");
    expect(reason(textUpdate(group(3), "/help"))).toBe("command");
    expect(reason(textUpdate({ fromId: 2, chatId: GROUP, chatType: "group" }, "/help"))).toBe(
      "command",
    );
  });
});

describe("photos", () => {
  it("takes any photo in a private chat, using the largest size and keeping the caption", () => {
    const intent = classifyUpdate(
      photoUpdate(dm(2), { fileId: "big", caption: "dinner", size: 5000 }),
      scope,
    );
    expect(intent).toMatchObject({
      kind: "image",
      fileId: "big",
      fileSize: 5000,
      mimeType: null,
      caption: "dinner",
      origin: { chatKind: "private", userId: 2 },
    });
  });

  it("takes a group photo only when its caption is a command for the bot or mentions it", () => {
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "/split" }))).toBe("image");
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "/split@LULLET_bot mei" }))).toBe(
      "image",
    );
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "look @lullet_bot" }))).toBe(
      "image",
    );
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "@Lullet_Bot" }))).toBe("image");
    expect(reason(photoUpdate(group(), { fileId: "f" }))).toBe("not_a_trigger");
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "dinner" }))).toBe("not_a_trigger");
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "/split@other_bot" }))).toBe(
      "not_addressed",
    );
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "@lullet_bot_2" }))).toBe(
      "not_a_trigger",
    );
    expect(
      reason(photoUpdate(group(), { fileId: "f", caption: "hi @lullet_bot_2 and /split" })),
    ).toBe("not_a_trigger");
  });

  it("takes a group photo captioned with /import, which privacy mode lets through", () => {
    for (const caption of [
      "/import",
      "/import test",
      "/import split between mei and dad",
      "/import@lullet_bot test",
    ]) {
      expect(reason(photoUpdate(group(), { fileId: "f", caption }))).toBe("image");
    }
  });

  it("answers a bare /import in the group instead of ignoring it", () => {
    expect(reason(textUpdate(group(), "/import"))).toBe("command");
    expect(reason(textUpdate(group(), "/import@lullet_bot"))).toBe("command");
    expect(reason(textUpdate(group(), "/unknown"))).toBe("not_a_trigger");
  });

  it("cannot recognise a mention while the bot's username is unknown", () => {
    const unknown = { ...scope, botUsername: null };
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "@lullet_bot" }), unknown)).toBe(
      "not_a_trigger",
    );
    expect(reason(photoUpdate(group(), { fileId: "f", caption: "/split@whoever" }), unknown)).toBe(
      "image",
    );
  });

  it("takes images sent as files, and nothing else sent as a file", () => {
    const file = (mime: string | undefined) =>
      ({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 1, is_bot: false, first_name: "A" },
          chat: { id: 1, type: "private" },
          date: 0,
          document: {
            file_id: "doc",
            file_unique_id: "d",
            file_size: 10,
            ...(mime ? { mime_type: mime } : {}),
          },
        },
      }) as unknown as Update;
    expect(classifyUpdate(file("image/png"), scope)).toMatchObject({
      kind: "image",
      fileId: "doc",
      mimeType: "image/png",
    });
    expect(classifyUpdate(file("image/webp"), scope)).toMatchObject({ kind: "image" });
    expect(reason(file("application/pdf"))).toBe("no_content");
    expect(reason(file(undefined))).toBe("no_content");
  });
});

describe("commands", () => {
  it("parses a command with its target and arguments", () => {
    expect(parseCommand("/rate EUR 1.51")).toEqual({
      name: "rate",
      target: null,
      args: "EUR 1.51",
    });
    expect(parseCommand("/Rate@Lullet_Bot  EUR   1.51 ")).toEqual({
      name: "rate",
      target: "Lullet_Bot",
      args: "EUR   1.51",
    });
    expect(parseCommand("/help")).toEqual({ name: "help", target: null, args: "" });
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/ nope")).toBeNull();
  });

  it("recognises the commands and their arguments", () => {
    expect(classifyUpdate(textUpdate(dm(), "/rate EUR 1.51"), scope)).toMatchObject({
      kind: "command",
      name: "rate",
      args: "EUR 1.51",
    });
    for (const name of ["start", "help", "login", "alias"]) {
      expect(classifyUpdate(textUpdate(dm(), `/${name}`), scope)).toMatchObject({
        kind: "command",
        name,
      });
    }
  });

  it("answers unknown commands in private only, and only commands meant for this bot", () => {
    expect(classifyUpdate(textUpdate(dm(), "/dance"), scope)).toMatchObject({
      kind: "command",
      name: null,
    });
    expect(reason(textUpdate(group(), "/dance"))).toBe("not_a_trigger");
    expect(reason(textUpdate(group(), "/rate@other_bot EUR 1"))).toBe("not_addressed");
    expect(reason(textUpdate(group(), "/rate@lullet_bot EUR 1"))).toBe("command");
    expect(reason(textUpdate(dm(), "/"))).toBe("no_content");
  });
});

describe("replies and buttons", () => {
  it("passes a private reply on, and ignores chatter", () => {
    expect(classifyUpdate(textUpdate(dm(), "60 40", { replyTo: 55 }), scope)).toMatchObject({
      kind: "reply",
      text: "60 40",
      replyToMessageId: 55,
    });
    expect(reason(textUpdate(dm(), "hello"))).toBe("not_a_trigger");
    expect(reason(textUpdate(group(), "60 40", { replyTo: 55 }))).toBe("not_a_trigger");
    expect(
      reason({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 1, is_bot: false, first_name: "A" },
          chat: { id: 1, type: "private" },
          date: 0,
        },
      } as Update),
    ).toBe("no_content");
  });

  it("passes a button tap on with its data and message", () => {
    expect(
      classifyUpdate(callbackUpdate(dm(2), { messageId: 9, data: "c:x:y", queryId: "q" }), scope),
    ).toMatchObject({
      kind: "callback",
      callbackQueryId: "q",
      messageId: 9,
      data: "c:x:y",
    });
    const noMessage = {
      update_id: 1,
      callback_query: {
        id: "q",
        from: { id: 1, is_bot: false, first_name: "A" },
        chat_instance: "c",
        data: "x",
      },
    } as unknown as Update;
    expect(reason(noMessage)).toBe("no_content");
  });
});

describe("mentions", () => {
  it("matches the username as a whole word", () => {
    expect(mentionsBot("hi @lullet_bot!", "lullet_bot")).toBe(true);
    expect(mentionsBot("hi @lullet_bots", "lullet_bot")).toBe(false);
    expect(mentionsBot("x@lullet_bot", "lullet_bot")).toBe(false);
    expect(mentionsBot("@lullet_bot", null)).toBe(false);
  });
});
