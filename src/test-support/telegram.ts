import { createHmac } from "node:crypto";

/**
 * Builds Mini App init data signed the way Telegram documents it, written independently of the
 * verifier under test (and with no bot involved): a test bot token is all that is needed.
 */
export const TEST_BOT_TOKEN = "123456:TEST-bot-token-for-lullet-tests-only";

export interface InitDataInput {
  readonly botToken?: string;
  readonly userId: number;
  readonly firstName?: string;
  readonly username?: string;
  readonly authDate: Date;
  /** Extra fields (for example `query_id`), signed along with the rest. */
  readonly extra?: Record<string, string>;
  /** Replace the user JSON verbatim (to build malformed user payloads). */
  readonly userJson?: string;
  /** Leave `auth_date` out entirely. */
  readonly omitAuthDate?: boolean;
  /** Leave the `user` field out entirely. */
  readonly omitUser?: boolean;
}

export function buildInitData(input: InitDataInput): string {
  const fields: Record<string, string> = {
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    ...(input.omitAuthDate
      ? {}
      : { auth_date: String(Math.floor(input.authDate.getTime() / 1000)) }),
    ...(input.omitUser
      ? {}
      : {
          user:
            input.userJson ??
            JSON.stringify({
              id: input.userId,
              first_name: input.firstName ?? "Test",
              username: input.username ?? "test_user",
              language_code: "en",
            }),
        }),
    ...input.extra,
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(input.botToken ?? TEST_BOT_TOKEN)
    .digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
