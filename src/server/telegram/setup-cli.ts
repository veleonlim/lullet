import { parseArgs } from "node:util";
import { GrammyError } from "grammy";
import { describeFailure } from "./api";
import { loadBotConfig, type BotConfig } from "./config";
import { buildSetupPlan, runSetup, setupProblem } from "./setup";

/**
 * The command line behind `pnpm telegram:setup`, as a function of its arguments and environment so
 * a test can run it against a fake Bot API. Prints only what is safe to paste into a chat: the bot
 * token and the webhook secret never appear in the output, and a failed call reports the kind of
 * failure rather than the request.
 */

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
}

type Env = Readonly<Record<string, string | undefined>>;

const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_GROUP_CHAT_ID",
] as const;

export const SETUP_USAGE = `Usage: pnpm telegram:setup [--url https://your-app.example.com] [--dry-run]

Registers the webhook (with its secret token), the command list and the Mini App button.
Safe to run again. Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_GROUP_CHAT_ID and
APP_URL from the environment; --url replaces APP_URL.`;

export async function runSetupCli(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  let values: { url?: string; "dry-run"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        url: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch {
    io.error(SETUP_USAGE);
    return 1;
  }
  if (values.help) {
    io.log(SETUP_USAGE);
    return 0;
  }
  const dryRun = values["dry-run"] === true;

  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    io.error(`Set ${missing.join(", ")} first (see docs/ENVIRONMENT.md).`);
    return 1;
  }
  let config: BotConfig | null;
  try {
    config = loadBotConfig(values.url ? { ...env, APP_URL: values.url } : env);
  } catch (error) {
    io.error(error instanceof Error ? error.message : "The Telegram settings are not valid.");
    return 1;
  }
  if (!config) return 1;

  const plan = buildSetupPlan(config);
  io.log(`Webhook:        ${plan.webhookUrl}`);
  io.log(`Mini App:       ${plan.miniAppUrl}`);
  io.log(`Group chat id:  ${String(config.groupChatId)}`);
  io.log(`Commands:       ${plan.commands.map((c) => `/${c.command}`).join(" ")}`);
  io.log(`Updates:        ${plan.allowedUpdates.join(", ")}`);
  const problem = setupProblem(plan);
  if (dryRun) {
    io.log(problem ?? "Dry run: nothing was sent to Telegram.");
    return 0;
  }
  if (problem) {
    io.error(problem);
    return 1;
  }

  try {
    const result = await runSetup(config, plan);
    io.log(`Bot:            @${result.botUsername}`);
    io.log(
      `Registered. Telegram reports webhook ${result.webhookUrl}, ${String(result.pendingUpdates)} pending updates.`,
    );
    if (result.lastError) io.error(`Telegram's last delivery error: ${result.lastError}`);
    return 0;
  } catch (error) {
    // A Bot API error can quote the request (and so the token), so only its kind is printed.
    io.error(`Telegram setup failed: ${describeFailure(error)}.`);
    if (error instanceof GrammyError && error.error_code === 401) {
      io.error("Telegram rejected the bot token. Copy it again from BotFather.");
    }
    return 1;
  }
}
