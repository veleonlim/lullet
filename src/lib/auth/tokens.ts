import { createHmac, randomBytes } from "node:crypto";

/** 256 bits of randomness, base64url encoded (43 characters). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What the database stores for a token: HMAC-SHA256 keyed with the server secret. The token itself
 * is already unguessable, so the point is that neither a database leak nor a backup yields
 * anything that can be replayed as a cookie or a login link.
 */
export function hashToken(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}
