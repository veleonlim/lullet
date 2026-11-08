import { createHash, timingSafeEqual } from "node:crypto";

/** The header Telegram sends with every webhook call when a secret token was registered. */
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Compares the secret from the header with the configured one in constant time. Both sides are
 * hashed first so the comparison always sees equal lengths and never leaks the length either.
 */
export function secretsMatch(provided: string | null, expected: string): boolean {
  if (provided === null || expected === "") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
