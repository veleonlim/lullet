import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Inline button data. Telegram allows 64 bytes, so a button carries only a short action code, the
 * draft id (22 characters instead of 36) and a nonce, plus small indexes. The nonce is an HMAC of
 * the draft id under a server secret: data that this server did not mint cannot name a draft.
 * Who may do what is still checked on the server for every tap (uploader, open draft).
 */

export const CALLBACK_DATA_MAX_BYTES = 64;

export type CallbackAction =
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
  | { readonly kind: "undo" }
  | { readonly kind: "summary" }
  /** Open the editor on a row (also prev and next). */
  | { readonly kind: "edit"; readonly row: number }
  | { readonly kind: "member"; readonly row: number; readonly member: number }
  | { readonly kind: "mode"; readonly row: number; readonly mode: "equal" | "percent" }
  | {
      readonly kind: "nudge";
      readonly row: number;
      readonly member: number;
      readonly delta: 1 | -1;
    }
  | { readonly kind: "category"; readonly row: number; readonly category: number }
  | { readonly kind: "payer"; readonly row: number; readonly member: number }
  | { readonly kind: "include"; readonly row: number };

export type CallbackFailure = "malformed" | "bad_nonce";

export type DecodedCallback =
  | { readonly ok: true; readonly importId: string; readonly action: CallbackAction }
  | { readonly ok: false; readonly reason: CallbackFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT_ID = /^[A-Za-z0-9_-]{22}$/;
const NONCE_LENGTH = 8;

export function shortId(uuid: string): string {
  if (!UUID.test(uuid)) throw new Error("not a lower case uuid");
  return Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url");
}

export function longId(short: string): string | null {
  if (!SHORT_ID.test(short)) return null;
  const hex = Buffer.from(short, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return shortId(uuid) === short ? uuid : null;
}

export function nonceFor(secret: string, importId: string): string {
  return createHmac("sha256", secret)
    .update(`lullet-callback-v1:${importId}`)
    .digest("base64url")
    .slice(0, NONCE_LENGTH);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeAction(action: CallbackAction): string {
  switch (action.kind) {
    case "confirm":
      return "c";
    case "cancel":
      return "x";
    case "undo":
      return "u";
    case "summary":
      return "s";
    case "edit":
      return `e.${String(action.row)}`;
    case "member":
      return `t.${String(action.row)}.${String(action.member)}`;
    case "mode":
      return `m.${String(action.row)}.${action.mode === "equal" ? "e" : "p"}`;
    case "nudge":
      return `n.${String(action.row)}.${String(action.member)}.${action.delta === 1 ? "u" : "d"}`;
    case "category":
      return `g.${String(action.row)}.${String(action.category)}`;
    case "payer":
      return `p.${String(action.row)}.${String(action.member)}`;
    case "include":
      return `i.${String(action.row)}`;
  }
}

const INDEX = /^\d{1,3}$/;

function decodeAction(text: string): CallbackAction | null {
  const [code, ...args] = text.split(".");
  const num = (value: string | undefined): number | null =>
    value !== undefined && INDEX.test(value) ? Number(value) : null;
  const row = num(args[0]);
  switch (code) {
    case "c":
    case "x":
    case "u":
    case "s": {
      if (args.length > 0) return null;
      if (code === "c") return { kind: "confirm" };
      if (code === "x") return { kind: "cancel" };
      return code === "u" ? { kind: "undo" } : { kind: "summary" };
    }
    case "e":
      return row !== null && args.length === 1 ? { kind: "edit", row } : null;
    case "i":
      return row !== null && args.length === 1 ? { kind: "include", row } : null;
    case "t":
    case "p": {
      const member = num(args[1]);
      if (row === null || member === null || args.length !== 2) return null;
      return code === "t" ? { kind: "member", row, member } : { kind: "payer", row, member };
    }
    case "g": {
      const category = num(args[1]);
      return row !== null && category !== null && args.length === 2
        ? { kind: "category", row, category }
        : null;
    }
    case "m": {
      if (row === null || args.length !== 2 || (args[1] !== "e" && args[1] !== "p")) return null;
      return { kind: "mode", row, mode: args[1] === "e" ? "equal" : "percent" };
    }
    case "n": {
      const member = num(args[1]);
      if (row === null || member === null || args.length !== 3) return null;
      if (args[2] !== "u" && args[2] !== "d") return null;
      return { kind: "nudge", row, member, delta: args[2] === "u" ? 1 : -1 };
    }
    default:
      return null;
  }
}

export function encodeCallback(secret: string, importId: string, action: CallbackAction): string {
  const data = `${encodeAction(action)}:${shortId(importId)}:${nonceFor(secret, importId)}`;
  if (Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) throw new Error("callback data too long");
  return data;
}

export function decodeCallback(secret: string, data: string): DecodedCallback {
  if (Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) return { ok: false, reason: "malformed" };
  const parts = data.split(":");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [actionText = "", short = "", nonce = ""] = parts;
  const importId = longId(short);
  const action = decodeAction(actionText);
  if (importId === null || action === null || nonce.length !== NONCE_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  if (!constantTimeEqual(nonce, nonceFor(secret, importId))) {
    return { ok: false, reason: "bad_nonce" };
  }
  return { ok: true, importId, action };
}
