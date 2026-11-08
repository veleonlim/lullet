/**
 * Registers the bot with Telegram after it has been created with BotFather. Safe to run again.
 *
 *   pnpm telegram:setup --dry-run                      print what would be registered, call nothing
 *   pnpm telegram:setup                                register the webhook, commands and Mini App button
 *   pnpm telegram:setup --url https://my-app.vercel.app   same, for this public address
 *
 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_GROUP_CHAT_ID and APP_URL from the
 * environment (.env, then .env.production.local). The token is never printed.
 */
import { runSetupCli } from "@/server/telegram/setup-cli";

process.exitCode = await runSetupCli(process.argv.slice(2), process.env, {
  log: (line) => {
    console.log(line);
  },
  error: (line) => {
    console.error(line);
  },
});
