# Environment reference

This is the one authoritative list of every setting lullet reads. The same table lives in code
(`src/lib/config/env.ts`); a unit test fails if this page, `.env.example` or the code drift apart.

**Where settings go**

- On Vercel: Project, Settings, Environment Variables, for the **Production** environment. This is
  what the running app reads.
- For the one-off commands you run on your own computer (`pnpm db:migrate:prod`,
  `pnpm auth:bootstrap`, `pnpm telegram:setup`, `pnpm export:csv`, `pnpm check:env`): a file called
  `.env.production.local` in the project folder. It is read after `.env`, is ignored by git, and
  should be deleted when you are done. Never commit it and never paste its contents into a chat.

**Check before you deploy.** `pnpm check:env` applies the same rules the server applies when it
starts, and prints which variables are set, missing or wrong. It never prints a value. In
production the server runs this check on start-up and refuses to start, naming every problem, so a
forgotten setting shows up in the Vercel logs at once.

**Requirement column.** _required_: production will not start without it. _optional_: has a
default, or leaves a feature off. _test only_: for tests and development; must not be set in
production (the start-up check refuses `LULLET_STORAGE=local`, `LULLET_EXTRACTOR=stub`,
`TELEGRAM_API_ROOT` and `LULLET_SKIP_ENV_CHECK`).

## Production variables

| Variable                  | Service        | Required | Example                                                                                        | What it is                                                                                                                                                                                         |
| ------------------------- | -------------- | -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Neon           | required | `postgresql://user:pass@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require` | Connection string with **Connection pooling ON** (the host contains `-pooler`). What the running app uses.                                                                                         |
| `DATABASE_URL_UNPOOLED`   | Neon           | optional | `postgresql://user:pass@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require`        | Connection string with **Connection pooling OFF**. Used only by `pnpm db:migrate:prod`, from your computer. Not needed on Vercel.                                                                  |
| `DATABASE_POOL_MAX`       | you            | optional | `1`                                                                                            | Connections per server instance. Default 5; set `1` on Vercel so many instances do not exhaust Neon's connection limit.                                                                            |
| `SESSION_SECRET`          | you            | required | `k3J9...` (48 random characters)                                                               | Hashes session cookies and login links at rest. At least 32 characters; make it with `openssl rand -base64 48`. Changing it signs everyone out.                                                    |
| `APP_URL`                 | Vercel         | required | `https://lullet.vercel.app`                                                                    | The public https address of the deployment, no trailing slash. Login links and the Telegram webhook are built from it.                                                                             |
| `TELEGRAM_BOT_TOKEN`      | BotFather      | required | `123456789:AAH-example_token_from_BotFather_xyz`                                               | The bot's token. Also the key that proves a Mini App sign-in came from Telegram.                                                                                                                   |
| `TELEGRAM_WEBHOOK_SECRET` | you            | required | `9f2c...` (64 hex characters)                                                                  | Telegram sends it with every webhook call and the app rejects calls without it. 16+ characters of A-Z a-z 0-9 `_` `-`; make it with `openssl rand -hex 32`.                                        |
| `TELEGRAM_GROUP_CHAT_ID`  | Telegram       | required | `-1001234567890`                                                                               | The numeric id of the family group chat (usually negative). The one chat the bot serves.                                                                                                           |
| `TELEGRAM_BOT_USERNAME`   | BotFather      | optional | `lullet_family_bot`                                                                            | The bot's username, with or without `@`. When unset the bot asks Telegram once per server instance.                                                                                                |
| `ANTHROPIC_API_KEY`       | Claude Console | required | `sk-ant-api03-...`                                                                             | Reads screenshots. Without it every upload would become an empty draft to fill in by hand, so production insists on it.                                                                            |
| `S3_ENDPOINT`             | Cloudflare R2  | required | `https://0123456789abcdef.r2.cloudflarestorage.com`                                            | The account's S3 API address. No bucket name and no path.                                                                                                                                          |
| `S3_BUCKET`               | Cloudflare R2  | required | `lullet-screenshots`                                                                           | The private bucket that holds original screenshots.                                                                                                                                                |
| `S3_ACCESS_KEY_ID`        | Cloudflare R2  | required | `0123456789abcdef0123456789abcdef`                                                             | Access Key ID of an R2 API token with Object Read and Write on that bucket.                                                                                                                        |
| `S3_SECRET_ACCESS_KEY`    | Cloudflare R2  | required | `0123...` (64 hex characters)                                                                  | Secret Access Key of the same token. Shown only once when the token is created.                                                                                                                    |
| `CRON_SECRET`             | you            | required | `5d1e...` (64 hex characters)                                                                  | Vercel Cron sends it as `Authorization: Bearer ...` to the daily clean-up. Without it the clean-up refuses every call, so screenshots would never be deleted. Make it with `openssl rand -hex 32`. |
| `IMPORT_DAILY_LIMIT`      | you            | optional | `30`                                                                                           | Screenshot uploads per person per rolling day (each costs a model call). Default 30.                                                                                                               |

## Test and development only

| Variable                | Used for                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `LULLET_STORAGE_DIR`    | Folder for screenshots when R2 is not configured (development). Default `.data/screenshots`.              |
| `LULLET_STORAGE`        | `local` allows folder storage in a production build. The end to end suite sets it. Refused in production. |
| `LULLET_EXTRACTOR`      | `stub` answers from canned files instead of calling Claude. Refused in production.                        |
| `LULLET_STUB_DIR`       | The folder of canned answers for `LULLET_EXTRACTOR=stub`.                                                 |
| `TELEGRAM_API_ROOT`     | A fake Bot API server instead of `https://api.telegram.org`. Refused in production.                       |
| `LULLET_SKIP_ENV_CHECK` | Switches the start-up check off. The end to end suite sets it. Refused by `pnpm check:env`.               |

## Set by the host, not by you

`NODE_ENV` (Vercel sets `production`), `NEXT_RUNTIME` and `NEXT_PHASE` (Next.js), and the
`VERCEL_*` variables are provided by the platform. Do not set them.

## Secrets hygiene

- Secrets live only in Vercel's environment settings and, briefly, in `.env.production.local`.
- The app never logs a secret, a request body, a screenshot or a model reply. Errors are logged by
  kind only. The check above names variables, never values.
- If a secret leaks (pasted in a chat, committed by mistake), replace it: make a new value, update
  Vercel, redeploy. For `TELEGRAM_BOT_TOKEN` use BotFather's `/revoke`; for the R2 token, delete
  and recreate it in Cloudflare; for the Claude key, delete it in the Console.
