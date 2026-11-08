import { Api, GrammyError, HttpError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { BotConfig } from "./config";

/**
 * The few Bot API calls the bot makes, behind a small interface so handlers are tested with a
 * recorder and the grammY-backed version is tested against a fake Telegram server.
 */
export interface SendOptions {
  readonly keyboard?: InlineKeyboardMarkup["inline_keyboard"];
  readonly replyToMessageId?: number;
  readonly noLinkPreview?: boolean;
}

export interface BotApi {
  sendMessage(chatId: number, html: string, options?: SendOptions): Promise<{ messageId: number }>;
  /** Edits a message in place. Editing to identical text is not an error. */
  editMessage(
    chatId: number,
    messageId: number,
    html: string,
    keyboard?: InlineKeyboardMarkup["inline_keyboard"],
  ): Promise<void>;
  answerCallback(callbackQueryId: string, text?: string, alert?: boolean): Promise<void>;
  /** Downloads a file Telegram holds. Throws FileTooLargeError past `maxBytes`. */
  downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array>;
  botUsername(): Promise<string | null>;
}

export class FileTooLargeError extends Error {
  constructor() {
    super("file too large");
    this.name = "FileTooLargeError";
  }
}

/** Telegram refuses to message someone who never started the bot or blocked it. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400);
}

function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

/** Keeps a failure loggable without echoing the request (it can hold the token). */
export function describeFailure(error: unknown): string {
  if (error instanceof GrammyError) return `telegram ${String(error.error_code)} ${error.method}`;
  if (error instanceof HttpError) return "telegram unreachable";
  return error instanceof Error ? error.name : "unexpected error";
}

export function createGrammyApi(config: BotConfig, fetchFile: typeof fetch = fetch): BotApi {
  const api = new Api(config.token, { apiRoot: config.apiRoot });
  let username: string | null = config.botUsername;
  let known = username !== null;

  return {
    async sendMessage(chatId, html, options = {}) {
      const sent = await api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
        ...(options.replyToMessageId === undefined
          ? {}
          : {
              reply_parameters: {
                message_id: options.replyToMessageId,
                allow_sending_without_reply: true,
              },
            }),
        ...(options.noLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
      });
      return { messageId: sent.message_id };
    },

    async editMessage(chatId, messageId, html, keyboard) {
      try {
        await api.editMessageText(chatId, messageId, html, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard ?? [] },
          link_preview_options: { is_disabled: true },
        });
      } catch (error) {
        if (!isNotModified(error)) throw error;
      }
    },

    async answerCallback(callbackQueryId, text, alert = false) {
      await api.answerCallbackQuery(callbackQueryId, {
        ...(text === undefined ? {} : { text: text.slice(0, 200) }),
        show_alert: alert,
      });
    },

    async downloadFile(fileId, maxBytes) {
      const file = await api.getFile(fileId);
      if (file.file_size !== undefined && file.file_size > maxBytes) throw new FileTooLargeError();
      if (!file.file_path) throw new Error("Telegram returned no file path");
      const url = `${config.apiRoot}/file/bot${config.token}/${file.file_path}`;
      const response = await fetchFile(url);
      if (!response.ok) throw new Error(`file download failed with ${String(response.status)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new FileTooLargeError();
      return bytes;
    },

    async botUsername() {
      if (!known) {
        username = (await api.getMe()).username;
        known = true;
      }
      return username;
    },
  };
}
