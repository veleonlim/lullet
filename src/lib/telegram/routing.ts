import type { Message, Update } from "grammy/types";

/**
 * Decides what an incoming Telegram update is, and whether the bot may act on it at all. This is
 * pure: the caller supplies the allowlist (the group chat id and the Telegram ids of the members).
 * Anything that is not clearly from an allowlisted person in an allowed chat becomes `ignore`, and
 * the bot never answers it, so strangers learn nothing.
 */

export interface BotScope {
  /** The one group chat the bot serves besides private chats. */
  readonly groupChatId: number;
  /** Telegram user ids of the members. */
  readonly allowedUserIds: ReadonlySet<number>;
  /** The bot's own username without "@"; null when unknown (mentions then cannot be recognised). */
  readonly botUsername: string | null;
}

export const COMMANDS = [
  "start",
  "help",
  "login",
  "rate",
  "alias",
  "import",
  "split",
  "cancel",
] as const;
export type CommandName = (typeof COMMANDS)[number];

export type ChatKind = "private" | "group";

export interface Origin {
  readonly chatId: number;
  readonly chatKind: ChatKind;
  readonly userId: number;
  readonly firstName: string;
}

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type IgnoreReason =
  | "unsupported_update"
  | "not_allowed"
  | "wrong_chat"
  | "bot_sender"
  | "not_addressed"
  | "not_a_trigger"
  | "no_content";

export type Intent =
  | { readonly kind: "ignore"; readonly reason: IgnoreReason }
  | {
      readonly kind: "command";
      readonly origin: Origin;
      readonly messageId: number;
      /** Null for a command the bot does not know. */
      readonly name: CommandName | null;
      readonly args: string;
    }
  | {
      readonly kind: "image";
      readonly origin: Origin;
      readonly messageId: number;
      readonly fileId: string;
      /** The size Telegram reports, when it does. */
      readonly fileSize: number | null;
      /** Set for an image sent as a file; photos are always JPEG. */
      readonly mimeType: string | null;
      readonly caption: string | null;
    }
  | {
      readonly kind: "callback";
      readonly origin: Origin;
      readonly callbackQueryId: string;
      readonly messageId: number;
      readonly data: string;
    }
  | {
      readonly kind: "reply";
      readonly origin: Origin;
      readonly messageId: number;
      readonly text: string;
      readonly replyToMessageId: number;
    }
  /** Plain text in a private chat that answers nothing in particular; /split's questions use it. */
  | {
      readonly kind: "text";
      readonly origin: Origin;
      readonly messageId: number;
      readonly text: string;
    };

const ignore = (reason: IgnoreReason): Intent => ({ kind: "ignore", reason });

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** "/rate@lullet_bot EUR 1.51" gives the command, who it is addressed to and the rest. */
export function parseCommand(
  text: string,
): { name: string; target: string | null; args: string } | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@([A-Za-z0-9_]{3,32}))?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return {
    name: (match[1] ?? "").toLowerCase(),
    target: match[2] ?? null,
    args: (match[3] ?? "").trim(),
  };
}

/** Whether a command is meant for this bot: unaddressed, or addressed to it by name. */
function isForUs(target: string | null, scope: BotScope): boolean {
  if (target === null) return true;
  return scope.botUsername === null || sameName(target, scope.botUsername);
}

export function mentionsBot(text: string, botUsername: string | null): boolean {
  if (botUsername === null) return false;
  const escaped = botUsername.replace(/[^A-Za-z0-9_]/g, "");
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "i").test(text);
}

function originOf(
  from: { id: number; first_name: string },
  chat: { id: number; type: string },
  scope: BotScope,
): Origin | "wrong_chat" | "not_allowed" {
  if (!scope.allowedUserIds.has(from.id)) return "not_allowed";
  if (chat.type === "private") {
    // In a private chat the chat id is the user's id; anything else would be someone else's chat.
    return chat.id === from.id
      ? { chatId: chat.id, chatKind: "private", userId: from.id, firstName: from.first_name }
      : "wrong_chat";
  }
  if ((chat.type === "group" || chat.type === "supergroup") && chat.id === scope.groupChatId) {
    return { chatId: chat.id, chatKind: "group", userId: from.id, firstName: from.first_name };
  }
  return "wrong_chat";
}

function classifyImage(message: Message): {
  fileId: string;
  fileSize: number | null;
  mimeType: string | null;
} | null {
  const photos = message.photo;
  if (photos && photos.length > 0) {
    // The largest size is the one with the most pixels.
    const best = photos.reduce((a, b) => (b.width * b.height >= a.width * a.height ? b : a));
    return { fileId: best.file_id, fileSize: best.file_size ?? null, mimeType: null };
  }
  const doc = message.document;
  if (doc?.mime_type && (IMAGE_MIME_TYPES as readonly string[]).includes(doc.mime_type)) {
    return { fileId: doc.file_id, fileSize: doc.file_size ?? null, mimeType: doc.mime_type };
  }
  return null;
}

function classifyMessage(message: Message, scope: BotScope): Intent {
  const from = message.from;
  if (!from) return ignore("not_allowed");
  if (from.is_bot) return ignore("bot_sender");
  const origin = originOf(from, message.chat, scope);
  if (origin === "wrong_chat" || origin === "not_allowed") return ignore(origin);

  const image = classifyImage(message);
  if (image) {
    const caption = message.caption ?? null;
    if (origin.chatKind === "group") {
      // In the group a photo counts only when its caption is a command for us or names the bot.
      // Telegram's privacy mode only passes a bot the commands addressed to it, so in practice the
      // command is the way in; a mention is read too, for a bot whose privacy mode is off.
      const command = caption === null ? null : parseCommand(caption);
      const isCommand = command !== null && isForUs(command.target, scope);
      if (command !== null && !isCommand) return ignore("not_addressed");
      if (!isCommand && !(caption !== null && mentionsBot(caption, scope.botUsername))) {
        return ignore("not_a_trigger");
      }
    }
    return { kind: "image", origin, messageId: message.message_id, ...image, caption };
  }

  const text = message.text;
  if (text === undefined) return ignore("no_content");
  if (text.startsWith("/")) {
    const command = parseCommand(text);
    if (!command) return ignore("no_content");
    if (!isForUs(command.target, scope)) return ignore("not_addressed");
    const known = COMMANDS.find((name) => name === command.name) ?? null;
    // An unknown command is answered with the help text in a private chat, never in the group.
    if (known === null && origin.chatKind === "group") return ignore("not_a_trigger");
    return {
      kind: "command",
      origin,
      messageId: message.message_id,
      name: known,
      args: command.args,
    };
  }
  if (origin.chatKind === "private" && message.reply_to_message) {
    return {
      kind: "reply",
      origin,
      messageId: message.message_id,
      text,
      replyToMessageId: message.reply_to_message.message_id,
    };
  }
  if (origin.chatKind === "private") {
    return { kind: "text", origin, messageId: message.message_id, text };
  }
  return ignore("not_a_trigger");
}

export function classifyUpdate(update: Update, scope: BotScope): Intent {
  if (update.message) return classifyMessage(update.message, scope);
  const query = update.callback_query;
  if (query) {
    if (query.from.is_bot) return ignore("bot_sender");
    const message = query.message;
    if (!message || query.data === undefined) return ignore("no_content");
    const origin = originOf(query.from, message.chat, scope);
    if (origin === "wrong_chat" || origin === "not_allowed") return ignore(origin);
    return {
      kind: "callback",
      origin,
      callbackQueryId: query.id,
      messageId: message.message_id,
      data: query.data,
    };
  }
  return ignore("unsupported_update");
}
