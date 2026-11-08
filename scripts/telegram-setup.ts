/**
 * Registers the bot with Telegram, once, after the captain has created it with BotFather:
 *
 *   pnpm telegram:setup --dry-run   print what would be registered, call nothing
 *   pnpm telegram:setup             register the webhook, the commands and the Mini App button
 *
 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_GROUP_CHAT_ID and APP_URL from the
 * environment (or .env). Nothing is hard coded and the token is never printed.
 */
import { loadBotConfig } from "@/server/telegram/config";
import { buildSetupPlan, runSetup, setupProblem } from "@/server/telegram/setup";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadBotConfig();
  if (!config) {
    console.error(
      "Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_GROUP_CHAT_ID first (see the README, section Telegram bot).",
    );
    return 1;
  }
  const plan = buildSetupPlan(config);
  console.log(`Webhook:        ${plan.webhookUrl}`);
  console.log(`Mini App:       ${plan.miniAppUrl}`);
  console.log(`Group chat id:  ${String(config.groupChatId)}`);
  console.log(`Commands:       ${plan.commands.map((c) => `/${c.command}`).join(" ")}`);
  console.log(`Updates:        ${plan.allowedUpdates.join(", ")}`);
  const problem = setupProblem(plan);
  if (problem && !dryRun) {
    console.error(problem);
    return 1;
  }
  if (dryRun) {
    console.log(problem ?? "Dry run: nothing was sent to Telegram.");
    return 0;
  }
  const result = await runSetup(config, plan);
  console.log(
    `Registered. Telegram reports webhook ${result.webhookUrl}, ${String(result.pendingUpdates)} pending updates.`,
  );
  if (result.lastError) console.error(`Telegram's last delivery error: ${result.lastError}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A Bot API error can quote the request, so only the kind of failure is printed.
    console.error(error instanceof Error ? error.name : "Setup failed");
    process.exitCode = 1;
  });
