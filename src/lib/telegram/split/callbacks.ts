import { createHmac, timingSafeEqual } from "node:crypto";
import { longId, shortId } from "@/lib/telegram/callbacks";

/**
 * Inline button data for /split. Same idea as the draft buttons (`../callbacks.ts`): a short
 * action code, the flow's id in 22 characters and an HMAC nonce, so data this server did not mint
 * cannot name a flow. The leading `w` keeps the two kinds apart. The bot still checks, on every
 * tap, that the button belongs to the person's open flow and to the question being asked.
 */

export const SPLIT_CALLBACK_PREFIX = "w";

/** The fields the Edit screen offers, in button order. */
export const EDIT_FIELDS = [
  "title",
  "amount",
  "payers",
  "sharers",
  "method",
  "date",
  "category",
] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

export type SplitAction =
  /** Index into the currency buttons. */
  | { readonly kind: "currency"; readonly index: number }
  | { readonly kind: "payer"; readonly member: number }
  | { readonly kind: "payers_done" }
  | { readonly kind: "payers_equal" }
  | { readonly kind: "sharer"; readonly member: number }
  | { readonly kind: "sharers_done" }
  | { readonly kind: "method"; readonly method: "equal" | "percent" | "exact" }
  | { readonly kind: "day"; readonly day: "today" | "yesterday" }
  | { readonly kind: "category"; readonly index: number }
  | { readonly kind: "category_skip" }
  | { readonly kind: "confirm" }
  | { readonly kind: "edit" }
  | { readonly kind: "edit_field"; readonly field: EditField }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" };

export type DecodedSplitCallback =
  | { readonly ok: true; readonly flowId: string; readonly action: SplitAction }
  | { readonly ok: false };

const NONCE_LENGTH = 8;
const INDEX = /^\d{1,3}$/;

function nonceFor(secret: string, flowId: string): string {
  return createHmac("sha256", secret)
    .update(`lullet-split-callback-v1:${flowId}`)
    .digest("base64url")
    .slice(0, NONCE_LENGTH);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const METHOD_CODE = { equal: "e", percent: "p", exact: "x" } as const;
const DAY_CODE = { today: "t", yesterday: "y" } as const;

function encodeAction(action: SplitAction): string {
  switch (action.kind) {
    case "currency":
      return `${SPLIT_CALLBACK_PREFIX}.c.${String(action.index)}`;
    case "payer":
      return `${SPLIT_CALLBACK_PREFIX}.p.${String(action.member)}`;
    case "payers_done":
      return `${SPLIT_CALLBACK_PREFIX}.pd`;
    case "payers_equal":
      return `${SPLIT_CALLBACK_PREFIX}.pe`;
    case "sharer":
      return `${SPLIT_CALLBACK_PREFIX}.h.${String(action.member)}`;
    case "sharers_done":
      return `${SPLIT_CALLBACK_PREFIX}.hd`;
    case "method":
      return `${SPLIT_CALLBACK_PREFIX}.m.${METHOD_CODE[action.method]}`;
    case "day":
      return `${SPLIT_CALLBACK_PREFIX}.d.${DAY_CODE[action.day]}`;
    case "category":
      return `${SPLIT_CALLBACK_PREFIX}.g.${String(action.index)}`;
    case "category_skip":
      return `${SPLIT_CALLBACK_PREFIX}.gs`;
    case "confirm":
      return `${SPLIT_CALLBACK_PREFIX}.ok`;
    case "edit":
      return `${SPLIT_CALLBACK_PREFIX}.ed`;
    case "edit_field":
      return `${SPLIT_CALLBACK_PREFIX}.f.${String(EDIT_FIELDS.indexOf(action.field))}`;
    case "back":
      return `${SPLIT_CALLBACK_PREFIX}.bk`;
    case "cancel":
      return `${SPLIT_CALLBACK_PREFIX}.no`;
  }
}

function decodeAction(text: string): SplitAction | null {
  const [prefix, code, arg, ...rest] = text.split(".");
  if (prefix !== SPLIT_CALLBACK_PREFIX || rest.length > 0) return null;
  const index = arg !== undefined && INDEX.test(arg) ? Number(arg) : null;
  switch (code) {
    case "c":
      return index === null ? null : { kind: "currency", index };
    case "p":
      return index === null ? null : { kind: "payer", member: index };
    case "h":
      return index === null ? null : { kind: "sharer", member: index };
    case "g":
      return index === null ? null : { kind: "category", index };
    case "f": {
      const field = index === null ? undefined : EDIT_FIELDS[index];
      return field === undefined ? null : { kind: "edit_field", field };
    }
    case "m":
      return arg === "e" || arg === "p" || arg === "x"
        ? { kind: "method", method: arg === "e" ? "equal" : arg === "p" ? "percent" : "exact" }
        : null;
    case "d":
      return arg === "t" || arg === "y"
        ? { kind: "day", day: arg === "t" ? "today" : "yesterday" }
        : null;
    case "pd":
    case "pe":
    case "hd":
    case "gs":
    case "ok":
    case "ed":
    case "bk":
    case "no": {
      if (arg !== undefined) return null;
      const kind = {
        pd: "payers_done",
        pe: "payers_equal",
        hd: "sharers_done",
        gs: "category_skip",
        ok: "confirm",
        ed: "edit",
        bk: "back",
        no: "cancel",
      } as const;
      return { kind: kind[code] };
    }
    default:
      return null;
  }
}

export function isSplitCallback(data: string): boolean {
  return data.startsWith(`${SPLIT_CALLBACK_PREFIX}.`);
}

export function encodeSplitCallback(secret: string, flowId: string, action: SplitAction): string {
  return `${encodeAction(action)}:${shortId(flowId)}:${nonceFor(secret, flowId)}`;
}

export function decodeSplitCallback(secret: string, data: string): DecodedSplitCallback {
  const parts = data.split(":");
  if (parts.length !== 3) return { ok: false };
  const [actionText = "", short = "", nonce = ""] = parts;
  const flowId = longId(short);
  const action = decodeAction(actionText);
  if (flowId === null || action === null || nonce.length !== NONCE_LENGTH) return { ok: false };
  if (!sameText(nonce, nonceFor(secret, flowId))) return { ok: false };
  return { ok: true, flowId, action };
}
