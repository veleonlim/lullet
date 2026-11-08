import type { Update } from "grammy/types";

/** Builders for the updates Telegram would POST to the webhook, for tests. */

// Starts from the clock so ids from one run never collide with those a persistent test database saw before.
let counter = Date.now() * 100;
export const nextUpdateId = (): number => ++counter;

export interface Where {
  readonly fromId: number;
  readonly chatId: number;
  readonly chatType?: "private" | "group" | "supergroup" | "channel";
  readonly firstName?: string;
  readonly isBot?: boolean;
}

function who(where: Where) {
  return {
    from: {
      id: where.fromId,
      is_bot: where.isBot ?? false,
      first_name: where.firstName ?? "Tester",
    },
    chat: { id: where.chatId, type: where.chatType ?? "private" },
    date: 1_790_000_000,
  } as const;
}

export function photoUpdate(
  where: Where,
  options: {
    fileId: string;
    caption?: string;
    messageId?: number;
    updateId?: number;
    size?: number;
  },
): Update {
  return {
    update_id: options.updateId ?? nextUpdateId(),
    message: {
      message_id: options.messageId ?? counter,
      ...who(where),
      photo: [
        { file_id: `${options.fileId}-small`, file_unique_id: "s", width: 90, height: 160 },
        {
          file_id: options.fileId,
          file_unique_id: "l",
          width: 720,
          height: 1280,
          ...(options.size === undefined ? {} : { file_size: options.size }),
        },
      ],
      ...(options.caption === undefined ? {} : { caption: options.caption }),
    },
  } as Update;
}

export function textUpdate(
  where: Where,
  text: string,
  options: { messageId?: number; updateId?: number; replyTo?: number } = {},
): Update {
  return {
    update_id: options.updateId ?? nextUpdateId(),
    message: {
      message_id: options.messageId ?? counter,
      ...who(where),
      text,
      ...(options.replyTo === undefined
        ? {}
        : { reply_to_message: { message_id: options.replyTo, ...who(where), date: 0 } }),
    },
  } as Update;
}

export function callbackUpdate(
  where: Where,
  options: { messageId: number; data: string; updateId?: number; queryId?: string },
): Update {
  return {
    update_id: options.updateId ?? nextUpdateId(),
    callback_query: {
      id: options.queryId ?? `cq-${String(counter)}`,
      from: who(where).from,
      chat_instance: "x",
      data: options.data,
      message: { message_id: options.messageId, ...who(where) },
    },
  } as Update;
}
