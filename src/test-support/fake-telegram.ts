import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Telegram Bot API, for tests only: it speaks just enough of the HTTP API for
 * the bot (send, edit, answer, getFile and file download) and records everything the bot does.
 * No real bot, token or network is involved. It enforces Telegram's 4096 character cap.
 */

export interface FakeButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly url?: string;
  readonly web_app?: { url: string };
}

export interface FakeMessage {
  readonly chatId: number;
  readonly messageId: number;
  text: string;
  keyboard: FakeButton[][];
  readonly replyTo: number | null;
  edits: number;
}

export interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  readonly messages: FakeMessage[] = [];
  readonly answers: { id: string; text: string | undefined; alert: boolean }[] = [];
  /** Chats the bot cannot message (the person never pressed Start). */
  readonly blockedChats = new Set<number>();
  private readonly files = new Map<string, Uint8Array>();
  private nextMessageId = 100;
  private server: Server | undefined;
  url = "";

  constructor(readonly token: string) {}

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        (reply) => {
          res.writeHead(reply.status, { "Content-Type": reply.type });
          res.end(reply.body);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  }

  reset(): void {
    this.calls.length = 0;
    this.messages.length = 0;
    this.answers.length = 0;
    this.blockedChats.clear();
    this.files.clear();
  }

  /** Makes a file downloadable the way a photo or document sent in a chat is. */
  addFile(fileId: string, bytes: Uint8Array): void {
    this.files.set(fileId, bytes);
  }

  messagesTo(chatId: number): FakeMessage[] {
    return this.messages.filter((m) => m.chatId === chatId);
  }

  lastTo(chatId: number): FakeMessage {
    const message = this.messagesTo(chatId).at(-1);
    if (!message) throw new Error(`the bot sent nothing to chat ${String(chatId)}`);
    return message;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** The callback data of the first button whose label contains `label`. */
  callbackFor(message: FakeMessage, label: string): string {
    const found = message.keyboard.flat().find((b) => b.text.includes(label) && b.callback_data);
    if (!found?.callback_data) {
      throw new Error(
        `no button "${label}" in [${message.keyboard
          .flat()
          .map((b) => b.text)
          .join(" | ")}]`,
      );
    }
    return found.callback_data;
  }

  hasButton(message: FakeMessage, label: string): boolean {
    return message.keyboard.flat().some((b) => b.text.includes(label));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; type: string; body: string | Uint8Array }> {
    const url = new URL(req.url ?? "/", "http://fake");
    const json = (status: number, body: unknown) => ({
      status,
      type: "application/json",
      body: JSON.stringify(body),
    });
    const fail = (code: number, description: string) =>
      json(code, { ok: false, error_code: code, description });

    const file = new RegExp(`^/file/bot${this.token}/(.+)$`).exec(url.pathname);
    if (file?.[1]) {
      const bytes = this.files.get(file[1].replace(/^files\//, ""));
      return bytes
        ? { status: 200, type: "application/octet-stream", body: bytes }
        : { status: 404, type: "text/plain", body: "" };
    }
    const match = new RegExp(`^/bot([^/]+)/(\\w+)$`).exec(url.pathname);
    if (!match) return fail(404, "Not Found");
    if (match[1] !== this.token) return fail(401, "Unauthorized");
    const method = match[2] ?? "";
    const params = await this.body(req);
    this.calls.push({ method, params });

    const chatId = Number(params.chat_id);
    const keyboard = (params.reply_markup as { inline_keyboard?: FakeButton[][] } | undefined)
      ?.inline_keyboard;
    switch (method) {
      case "getMe":
        return json(200, {
          ok: true,
          result: { id: 999, is_bot: true, first_name: "lullet", username: "lullet_test_bot" },
        });
      case "sendMessage": {
        const text = typeof params.text === "string" ? params.text : "";
        if (text.length > 4096) return fail(400, "Bad Request: message is too long");
        if (this.blockedChats.has(chatId)) {
          return fail(403, "Forbidden: bot can't initiate conversation with a user");
        }
        const message: FakeMessage = {
          chatId,
          messageId: this.nextMessageId++,
          text,
          keyboard: keyboard ?? [],
          replyTo:
            (params.reply_parameters as { message_id?: number } | undefined)?.message_id ?? null,
          edits: 0,
        };
        this.messages.push(message);
        return json(200, {
          ok: true,
          result: {
            message_id: message.messageId,
            date: 0,
            chat: { id: chatId, type: "private" },
            text,
          },
        });
      }
      case "editMessageText": {
        const text = typeof params.text === "string" ? params.text : "";
        if (text.length > 4096) return fail(400, "Bad Request: message is too long");
        const message = this.messages.find(
          (m) => m.chatId === chatId && m.messageId === Number(params.message_id),
        );
        if (!message) return fail(400, "Bad Request: message to edit not found");
        const next = keyboard ?? [];
        if (message.text === text && JSON.stringify(message.keyboard) === JSON.stringify(next)) {
          return fail(400, "Bad Request: message is not modified");
        }
        message.text = text;
        message.keyboard = next;
        message.edits += 1;
        return json(200, {
          ok: true,
          result: {
            message_id: message.messageId,
            date: 0,
            chat: { id: chatId, type: "private" },
            text,
          },
        });
      }
      case "answerCallbackQuery":
        this.answers.push({
          id: String(params.callback_query_id),
          text: typeof params.text === "string" ? params.text : undefined,
          alert: params.show_alert === true,
        });
        return json(200, { ok: true, result: true });
      case "getFile": {
        const id = String(params.file_id);
        const bytes = this.files.get(id);
        if (!bytes) return fail(400, "Bad Request: invalid file_id");
        return json(200, {
          ok: true,
          result: {
            file_id: id,
            file_unique_id: id,
            file_size: bytes.length,
            file_path: `files/${id}`,
          },
        });
      }
      case "setWebhook":
      case "setMyCommands":
      case "setChatMenuButton":
        return json(200, { ok: true, result: true });
      case "getWebhookInfo":
        return json(200, {
          ok: true,
          result: {
            url: String(this.lastParam("setWebhook", "url")),
            pending_update_count: 0,
            has_custom_certificate: false,
          },
        });
      default:
        return fail(404, `Not Found: ${method}`);
    }
  }

  private lastParam(method: string, key: string): unknown {
    return this.callsTo(method).at(-1)?.params[key];
  }
}
