import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { INIT_DATA_MAX_AGE_SECONDS } from "./config";

/**
 * Verification of Telegram Mini App init data (`Telegram.WebApp.initData`), following
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app :
 *
 *   data_check_string = every received field except `hash`, as `key=value` (values URL-decoded),
 *                       sorted by key and joined with "\n"
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   hash              = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
 *
 * The hash is compared in constant time and `auth_date` must be recent, so a captured init data
 * string stops working after the freshness window.
 */

const MAX_INIT_DATA_LENGTH = 4096;
/** Tolerated clock difference when `auth_date` is slightly in the future. */
const CLOCK_SKEW_SECONDS = 60;

const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

export interface TelegramUser {
  readonly id: number;
  readonly firstName: string | undefined;
  readonly lastName: string | undefined;
  readonly username: string | undefined;
}

export type InitDataFailure =
  | "malformed"
  | "missing_hash"
  | "bad_signature"
  | "missing_auth_date"
  | "expired"
  | "from_the_future"
  | "missing_user";

export type InitDataResult =
  | { readonly ok: true; readonly user: TelegramUser; readonly authDate: Date }
  | { readonly ok: false; readonly reason: InitDataFailure };

export interface VerifyInitDataOptions {
  readonly now?: Date;
  readonly maxAgeSeconds?: number;
}

const fail = (reason: InitDataFailure): InitDataResult => ({ ok: false, reason });

function expectedHash(botToken: string, fields: ReadonlyMap<string, string>): string {
  const dataCheckString = [...fields]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
}

export function verifyInitData(
  initData: string,
  botToken: string,
  options: VerifyInitDataOptions = {},
): InitDataResult {
  if (initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH) return fail("malformed");

  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(initData)) {
    // A repeated key would make "the" value ambiguous between us and Telegram: refuse.
    if (fields.has(key)) return fail("malformed");
    fields.set(key, value);
  }

  const receivedHash = fields.get("hash");
  if (receivedHash === undefined) return fail("missing_hash");
  if (!/^[0-9a-f]{64}$/.test(receivedHash)) return fail("bad_signature");

  const expected = Buffer.from(expectedHash(botToken, fields), "hex");
  const received = Buffer.from(receivedHash, "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return fail("bad_signature");
  }

  // The signature is good from here on: the remaining checks are about freshness and content.
  const authDateText = fields.get("auth_date");
  if (authDateText === undefined || !/^\d{1,12}$/.test(authDateText)) {
    return fail("missing_auth_date");
  }
  const authDateSeconds = Number(authDateText);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (authDateSeconds > nowSeconds + CLOCK_SKEW_SECONDS) return fail("from_the_future");
  if (nowSeconds - authDateSeconds > (options.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS)) {
    return fail("expired");
  }

  const userJson = fields.get("user");
  if (userJson === undefined) return fail("missing_user");
  let parsedUser: z.ZodSafeParseResult<z.infer<typeof telegramUserSchema>>;
  try {
    parsedUser = telegramUserSchema.safeParse(JSON.parse(userJson));
  } catch {
    return fail("missing_user");
  }
  if (!parsedUser.success) return fail("missing_user");

  return {
    ok: true,
    authDate: new Date(authDateSeconds * 1000),
    user: {
      id: parsedUser.data.id,
      firstName: parsedUser.data.first_name,
      lastName: parsedUser.data.last_name,
      username: parsedUser.data.username,
    },
  };
}
