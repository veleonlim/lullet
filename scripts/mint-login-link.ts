/**
 * Mints a one-time browser login link for a Telegram user and prints it. This is the stand-in for
 * the bot's /login command until the bot exists, and a break-glass tool afterwards.
 *
 *   LULLET_ALLOW_LINK_MINT=1 pnpm auth:mint-link <telegram-user-id>
 *
 * Guarded: it refuses to run unless LULLET_ALLOW_LINK_MINT=1 is set on the command line, because
 * whoever holds the printed link can sign in as that member. It reads DATABASE_URL, SESSION_SECRET
 * and APP_URL from the environment (or .env).
 */
import { getDatabase } from "@/db/client";
import { mintLoginLink } from "@/lib/auth/db/login-links";

async function main(): Promise<number> {
  if (process.env.LULLET_ALLOW_LINK_MINT !== "1") {
    console.error(
      "Refusing to mint a login link. Set LULLET_ALLOW_LINK_MINT=1 to confirm you mean to sign someone in.",
    );
    return 1;
  }
  const arg = process.argv[2];
  if (!arg || !/^\d{1,15}$/.test(arg)) {
    console.error("Usage: LULLET_ALLOW_LINK_MINT=1 pnpm auth:mint-link <telegram-user-id>");
    return 1;
  }

  const link = await mintLoginLink(Number(arg));
  if (!link) {
    console.error(`Telegram user ${arg} is not on the allowlist. No link was created.`);
    return 2;
  }
  console.log(link.url);
  console.error(`Valid until ${link.expiresAt.toISOString()}, works once.`);
  return 0;
}

main()
  .then(async (code) => {
    await getDatabase().pool.end();
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
