# lullet

Europe Split: a Splitwise-like expense splitter for four people (the requester, their girlfriend and their parents), first used on a trip to Switzerland and Italy.

Telegram is the capture and edit surface; this web app is the database and dashboard. This repository holds the foundation (app skeleton, database schema, the money and ledger library, the quality gates), Telegram sign-in, the web ledger (expense list, add and edit, soft delete and restore, history, balances and settle-up), the screenshot import (upload, read by Claude, review, confirm, undo), the dashboard with daily budgets and daily exchange rates, and the Telegram bot (described under [Telegram bot](#telegram-bot)).

## Stack

| Area     | Choice                                                                           |
| -------- | -------------------------------------------------------------------------------- |
| App      | Next.js (App Router), React, TypeScript (strict), Tailwind CSS                   |
| Database | PostgreSQL 18, Drizzle ORM and drizzle-kit migrations, `pg` (node-postgres)      |
| Tests    | Vitest, fast-check (property tests), Playwright (phone and desktop projects)     |
| Tooling  | pnpm, ESLint (typescript-eslint strict), Prettier                                |
| CI       | GitHub Actions                                                                   |
| Hosting  | Vercel Hobby, Neon Postgres, Cloudflare R2; see [docs/LAUNCH.md](docs/LAUNCH.md) |

All versions are pinned exactly in `package.json`. TypeScript is held at 6.0 because typescript-eslint does not support 7 yet.

## Getting started

Requirements: Node 24 or newer (`.nvmrc`), pnpm 12 (pinned by `packageManager`; run `corepack enable` or install it from npm), Docker for the local database, and Playwright's Chromium for end to end tests.

```sh
pnpm install
cp .env.example .env          # local settings; never commit .env
docker compose up -d          # Postgres 18 on localhost:5432
pnpm db:migrate               # apply migrations
pnpm auth:bootstrap --group "Switzerland and Italy" \
  --member "Name=<telegram-user-id>" --member "Name=<telegram-user-id>"   # fill the allowlist
pnpm db:seed --demo           # optional: dev group (Telegram ids 5100001 to 5100004), stand-in rates, sample expenses
pnpm dev                      # http://localhost:3000
pnpm auth:mint-link <telegram-user-id>   # a login link, without a bot
```

Every page needs a signed-in member, so the app is only useful once the allowlist is filled in; see [Sign in with Telegram](#sign-in-with-telegram).

First time running end to end tests: `pnpm exec playwright install chromium`.

## Scripts

| Script                         | What it does                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `build` / `start` | Next.js development server, production build, production server                                                                                    |
| `pnpm check:static`            | typecheck, ESLint and Prettier check (what `.no-mistakes.yaml` runs as `lint`)                                                                     |
| `pnpm typecheck`               | `tsc --noEmit`                                                                                                                                     |
| `pnpm lint`                    | ESLint                                                                                                                                             |
| `pnpm format` / `format:check` | Prettier write / check                                                                                                                             |
| `pnpm test`                    | Unit and property tests (no external services; what `.no-mistakes.yaml` runs as `test`)                                                            |
| `pnpm test:coverage`           | Same, with coverage thresholds on `src/lib`                                                                                                        |
| `pnpm test:integration`        | Integration tests against real Postgres; needs `DATABASE_URL`                                                                                      |
| `pnpm test:e2e`                | Playwright on a phone and a desktop viewport; needs Postgres (`DATABASE_URL`)                                                                      |
| `pnpm db:seed`                 | Create a dev group with four members linked to Telegram ids 5100001 to 5100004; `--reset` empties the ledger, `--demo` adds samples                |
| `pnpm eval:screenshots`        | Manual accuracy eval of the screenshot reader against the live Claude API (needs `ANTHROPIC_API_KEY`; see [Screenshot import](#screenshot-import)) |
| `pnpm auth:bootstrap`          | Create the group and link its members to Telegram accounts (once)                                                                                  |
| `pnpm auth:mint-link`          | Print a one-time browser login link for a member                                                                                                   |
| `pnpm telegram:setup`          | Register the webhook, commands and Mini App button with Telegram; safe to repeat (`--dry-run` prints the plan only, `--url` overrides `APP_URL`)   |
| `pnpm check:env`               | Check a set of production settings with the rules the server applies at start-up; prints names, never values                                       |
| `pnpm db:migrate:prod`         | Apply migrations through `DATABASE_URL_UNPOOLED` only, as a deliberate step (`--dry-run` counts what is waiting)                                   |
| `pnpm export:csv`              | Save the whole ledger as CSV files on your computer (read-only; see [docs/BACKUPS.md](docs/BACKUPS.md))                                            |
| `pnpm db:generate`             | Generate a migration from schema changes                                                                                                           |
| `pnpm db:migrate`              | Apply migrations to `DATABASE_URL_UNPOOLED` or `DATABASE_URL`                                                                                      |
| `pnpm db:check`                | Verify the migration history is consistent                                                                                                         |

`pnpm test:e2e` starts `pnpm dev` itself on port 3100 (or reuses a server already running there). With `CI=1` it serves the production build instead, so run `pnpm build` first. The suite uses its own database, `lullet_e2e` (set `E2E_DATABASE_NAME` to run two checkouts at once), created and migrated on the server `DATABASE_URL` points at, seeds the four ledger members (`src/db/seed-ids.ts`) and signs in through the real login-link flow, and its own made-up secrets and bot token; no real Telegram bot is involved.

`pnpm db:seed` and the end to end suite empty and write ledger data, so they refuse to run unless the database host is local (`localhost`, `127.0.0.1` or `::1`); there is no override. See `assertLocalDatabase` in `src/db/seed.ts`.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as separate jobs:

1. **Static checks**: typecheck, ESLint, Prettier, and that the committed migrations match the schema.
2. **Unit and property tests** with coverage thresholds.
3. **Integration tests** against a `postgres:18` service container.
4. **Build**: `next build`.
5. **Playwright** on the production build, phone and desktop projects, against a Postgres service container.

No job calls a live external service; exchange rate tests replay recorded responses.

## Environment and secrets

[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) is the one authoritative list of every variable: which service it comes from, whether it is required, an example and what it does. It mirrors the table in `src/lib/config/env.ts`, and a unit test fails if the table, that page, `.env.example` or the variables the code reads drift apart. Secrets come only from the environment (Vercel project settings in production, `.env` locally, never committed); for the one-off production commands (`db:migrate:prod`, `auth:bootstrap`, `telegram:setup`, `export:csv`, `check:env`) put them in `.env.production.local`, which is read after `.env` and ignored by git. Tests never need a real bot or real secrets.

**Start-up check.** In a production server (`NODE_ENV=production`), `src/instrumentation.ts` runs `assertProductionEnv` before the first request and refuses to start with one message that names every missing or malformed variable and never prints a value (it also refuses test-only switches such as `LULLET_EXTRACTOR=stub`). It is skipped during `next build`, in development and, through `LULLET_SKIP_ENV_CHECK`, in the end to end suite. `pnpm check:env` runs the same rules against a file before you deploy.

## Sign in with Telegram

Only four allowlisted Telegram users can use the app (decision D3). Everyone else gets no session and no data. Code is in `src/lib/auth/`; there are no passwords.

**The allowlist** is the `telegram_links` table: a Telegram user id is served only if it is linked to a member of the group. `pnpm auth:bootstrap` creates the group and its members (the first `--member` is the owner; the order is the group's fixed member order) and refuses to run twice. After that the owner re-links a member from the **Members** page (for example when someone loses their Telegram account). A re-bind signs the member's old sessions and unused login links out, and writes an `audit_log` row.

**Two ways in**

- **Mini App** (inside Telegram): the page reads the signed launch data (`tgWebAppData`) and posts it to `POST /api/auth/telegram`. The server checks it as Telegram documents ([Mini Apps: validating data](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)): HMAC-SHA256 with the key `HMAC_SHA256("WebAppData", bot token)` over the sorted `key=value` fields, compared in constant time, and `auth_date` no older than one hour. The Telegram user id must then be on the allowlist.
- **Browser**: the bot sends a one-time link. `mintLoginLink(telegramUserId)` in `src/lib/auth/db/login-links.ts` is the function it calls; it returns `null` for anyone not on the allowlist, and otherwise a URL `APP_URL/signin/link/<token>`. The token is 256 random bits, stored only as an HMAC hash, valid for 10 minutes, and used up by one atomic conditional `UPDATE`, so it works once even under concurrent requests. Minting a new link withdraws the member's older unused one. Opening the link only shows a **Continue** button (`POST /api/auth/link` consumes it), because Telegram fetches URLs in messages to build previews and a plain GET would burn the link. The sign-in page tells people to send `/login` to the bot, which now does exactly that (see [Telegram bot](#telegram-bot)).

Without a bot (local development, or a break-glass login), mint a link yourself: `pnpm auth:mint-link <telegram-user-id>` prints the URL (it works against production too if `DATABASE_URL`, `SESSION_SECRET` and `APP_URL` point there).

**Sessions** are server side (`sessions` table). The cookie `__Host-lullet_session` is `httpOnly`, `Secure`, `SameSite=Lax`, path `/`, and holds only a random token; the table stores its HMAC hash. A session lasts 30 days. Every login issues a new token and destroys the one the browser held (no session fixation); logout deletes the row, so a copied cookie stops working. A session also ends when the member leaves the group or the allowlist. The two cookie-setting POST routes refuse cross-site requests (`Sec-Fetch-Site` or `Origin`).

**Guarding pages**: `src/proxy.ts` sends cookie-less requests to `/signin` (and answers `401` for `/api/*`), and the `(app)` route group's layout checks the session for real. Pages, server actions and route handlers learn who is calling only through `getSession()` in `src/lib/auth/session.ts`, which returns `{ userId, groupId }` or `null`; the data access layer scopes every query by that `groupId`. `/api/health` and the sign-in routes are public.

The public auth routes need no request rate limit to resist guessing: a login link is 256 random bits that work once for ten minutes, Mini App data is an HMAC that must verify against the bot token, and both then need an allowlisted Telegram id. The limits that do cost money are enforced (see [Hardening](#hardening-and-deployment)).

## Database

Schema lives in `src/db/schema/` and migrations in `drizzle/`. Run `pnpm db:generate` after changing the schema and commit the result; CI fails if the migrations and schema disagree.

Tables: `users`, `groups` (with the trip's first and last day and time zone), `memberships` (with `is_owner`, at most one owner per group), `expenses`, `expense_payers`, `expense_shares`, `settlements`, `imports`, `import_rows`, `fx_rates` (stored market rates), `daily_rates` (per day default rate overrides), `budgets`, `audit_log`, `telegram_links`, `sessions`, `login_tokens`, and for the bot `telegram_updates` (handled update ids), `telegram_drafts` (the chat message showing each draft) and `member_aliases` (extra caption names).

Money is always an integer count of minor units (`4850` plus `EUR`), stored as `bigint`. The database itself enforces what it can, in `0000_core_schema.sql` and the hand written `0001_invariants.sql`:

- amounts are positive, currency codes are three capital letters, billed amount and currency come together
- payer amounts add up to the expense amount, and so do share amounts, checked at commit by deferred constraint triggers. An expense therefore has to be written together with its payers and shares in one transaction
- a payer, share, settlement party or uploader must belong to the group (composite foreign keys to `memberships`)
- expenses and settlements are soft deleted (`deleted_at` and `deleted_by` set together) and cannot be removed
- `audit_log` is append only and `fx_rates` rows can be neither changed nor deleted, so history does not move
- stored rates (`fx_rates` and `daily_rates`) are always quoted in SGD
- one active import per image hash per group, one default budget per group and one override per day

Connection handling is host agnostic: `src/db/client.ts` uses plain `pg`, which works against Docker Postgres locally and in CI and against Neon's pooled (PgBouncer, transaction mode) endpoint in production. It uses no named prepared statements or session state, and no platform specific API.

## Money and ledger library

`src/lib/money` is pure TypeScript with no UI or database code. It is the single place where amounts are parsed, split, converted and balanced.

- **Integer minor units only.** `currency.ts` holds the ISO 4217 exponent table (SGD, EUR, CHF and the other European currencies a traveller may meet). Floats never appear; ESLint forbids `parseFloat` and `Math.round` in this folder.
- **Parsing** (`parse.ts`): reads amounts as shown on screenshots in EU (`1.234,56`, `1 234,56`), US (`1,234.56`), Swiss (`1'234.56`) and plain formats, with an optional currency symbol or code, and negative signs or parentheses. It is strict and never guesses: a lone separator followed by three digits is read as thousands and flagged `thousands_inferred`; a missing currency is `currency_unknown`.
- **Splitting** (`allocate.ts`): largest remainder allocation for equal, exact, percent (basis points) and shares splits. Leftover cents go to the largest fractional remainder, ties to the earlier member in the group's fixed order. 14849 over three people is `[4950, 4950, 4949]`. Allocations always sum exactly. Several payers per expense are the same machinery.
- **Conversion** (`convert.ts`, `rate.ts`): to SGD with exact decimal rates, rounding half up. Precedence: shown in SGD, then the exact billed SGD figure, then a rate set on the expense (stored with the currency it applies to, and used only for an amount in that currency, never reinterpreted), then the group's default rate for that day, then the stored market rate. When the bank billed in a currency other than SGD, the billed amount is the one converted (at that day's rate for the billed currency) and the shown amount is kept for reference. With no rate available it fails with `missing_rate`.
- **Balances** (`ledger.ts`): never stored, always derived. SGD totals are decided once per expense and spread over the native payers and shares, so SGD balances sum to zero exactly. Native per currency balances are produced too.
- **Settle up** (`settle.ts`): the minimum number of transfers (exact search up to 14 people with a balance, a greedy fallback beyond).

Properties tested with fast-check: allocations sum exactly and stay within one unit of the exact share, parse and format round trip in every style, balances sum to zero in SGD and in every native currency, the order of expenses does not matter, suggested transfers always settle the group and match a brute force minimum.

### Exchange rate client

`src/lib/fx` defines `FxRateClient` and a Frankfurter implementation (free, no key, covers SGD and CHF). It validates responses with zod and reports the actual rate date, because weekends return the last business day. Tests replay responses recorded in `tests/fixtures/frankfurter`; nothing calls the live service in CI.

## The web ledger

Routes: `/expenses` (list grouped by day, newest first, with a Deleted filter), `/expenses/new`, `/expenses/[id]` (native amount, SGD figure and how it was worked out), `/expenses/[id]/edit`, `/expenses/[id]/history` (who changed what), `/balances` (net per member, fewest-payment settle-up suggestions, recorded settlements) and `/settlements/new`.

- **Add and edit** (`src/components/expense-form.tsx`): description, date, a fixed category list, amount and currency, an optional billed amount, an optional rate for this expense only, one or more payers with amounts, and a split that is equal (default), exact, percent or shares with per-person toggles. The same `validateExpenseForm` (zod plus the money library, `src/lib/ledger`) runs in the browser for live feedback and on the server as the authority; payers and shares must add up exactly.
- **Exchange rates**: the SGD figure follows the library's precedence (shown in SGD, billed SGD, the expense's own rate, the group's day rate, the stored market rate). The first time a day needs a market rate it is fetched from Frankfurter and stored, and each record keeps the rate it was priced with, so history never moves. If none can be fetched the form asks for a rate instead of guessing. Records without any rate are left out of the balances and flagged.
- **Soft delete and audit**: deleting only marks the row; every create, edit, delete and restore (expenses and settlements) writes an `audit_log` row in the same transaction, with the before and after, and the history page reads it back. Edits carry the version that was loaded, so overwriting someone else's change is refused.
- **Data access**: pages and server actions get the caller from `getSession()` and the ledger only from `openStore()` (`src/server/runtime.ts`, which sends a caller without a live session to `/signin`), which wraps the group-scoped store in `src/server/ledger/store.ts`. Every query there filters by the session's group (child tables and the audit log included), a user outside the group is refused, and ESLint stops `src/app` and `src/components` from importing the database. `tests/integration/ledger-scoping.test.ts` drives every store method with another group's ids and fails to compile when a method has no probe.

## Screenshot import

The four agreed steps: upload a screenshot, have it read into one row per payment (with a category), choose who paid (everyone else shares equally by default), then check, change and confirm. Nothing reaches the ledger until the uploader confirms. Code: `src/lib/import` (pure logic), `src/server/import` (storage, model, data access, jobs), `src/components/import` and the `/imports` pages and `/api/imports` routes.

**Upload** (`/imports/new`, `POST /api/imports`). Phone friendly. The server looks at the real bytes (PNG, JPEG or WebP; never the file name), caps the file at 4 MB (Vercel's body limit is 4.5 MB; large camera photos are shrunk in the browser first), limits each person to 30 uploads a rolling day, removes all metadata (EXIF with GPS and camera details, XMP, text chunks, comments; the pixels are not re-encoded), and takes the SHA-256 of what is stored. The same image (or the same one with different metadata) is rejected as already imported before any model call. Originals live behind the `ImageStorage` interface: Cloudflare R2 (`S3Storage`) in production, local files (`LocalFileStorage`) in development and tests. The bucket is never public and no signed link is handed out: `GET /api/imports/[id]/image` serves the bytes to signed-in members of the group.

**Reading.** `AnthropicExtractor` sends one request to `claude-haiku-5-5` with the official SDK: the image and a short prompt, no tools, the answer constrained by a JSON schema (`output_config.format`) and validated again with zod. The screenshot is treated as untrusted data. Amounts come back as the text shown on screen plus the model's own reading; our code re-parses the text with the money library and flags any disagreement, never fixes silently, and never guesses a currency (no visible currency means "needs input"). A refusal, a `max_tokens` stop or a reply that is not exactly the agreed shape gives an empty draft ("enter manually"), never a partial import. "Re-read" asks `claude-sonnet-5-5` (twice at most per screenshot) and replaces the rows; a failed re-read changes nothing. The API key is read only from `ANTHROPIC_API_KEY`.

**Drafts** live in `imports` and `import_rows`, which balances and the dashboard never read. A draft expires 24 hours after upload, or at once on Cancel. Each field of a row is `clear`, `uncertain` ("check", dotted underline), `guessed` (a date the model inferred, a category it was unsure of, shown as "check" too) or `unreadable` ("needs input", the row starts unticked and blocks Confirm until filled in or left unticked). Editing a field clears its doubt. Duplicates are caught in three layers: the same image hash, the same transaction (amount and currency, day within one, fuzzy merchant) against the ledger, and the same check against other open drafts, which also catches two overlapping scrolled screenshots. A match is flagged and unticked, never dropped. The payer is not required to match (the same bill entered by one person and screenshotted by another is the case worth catching); a matching payer only ranks higher.

**Review** (`/imports/[id]`). Paid by (the uploader by default, several payers split each payment equally), the payer's own share as a switch (off by default), Equal or Percent for the whole batch, and per row: tick or untick, member chips (tap Jamie off one row), category, description, date, amount, currency, billed amount, and its own Equal or Percent split. Totals per person and per currency update live, with a sum check against any total printed on the screenshot. Edits are saved as you go. "Review and add" opens "Confirm or make changes"; "OK, add to ledger" adds the ticked rows. Other members can look at a draft but only the uploader can change, confirm, undo or discard it.

**Confirm** is one transaction: it locks the import, adds every ticked row through the ledger's own insert (so each expense gets its audit row and its exchange rate handling), links each expense to its import row and writes an `import.confirm` audit entry. It is idempotent (a second confirm, or two at once, adds nothing more). If an exchange rate cannot be fetched the expense is still added and shows "No rate" until one is set. **Undo import** soft deletes the whole batch in one transaction (`import.undo`).

**Retention.** Originals are deleted 30 days after confirmation (immediately for cancelled and expired drafts); the extracted rows stay. `GET /api/cron/retention` (guarded by `CRON_SECRET`, scheduled in `vercel.json`) also expires drafts that ran out of time. It is safe to run twice, and one failing image never stops the rest.

**Tests.** Contract tests drive the extractor with hand-built Messages API responses (clean, ambiguous, refused, cut off, malformed, an injection attempt) and make no network call. Integration tests cover drafts, duplicates, confirm, undo, permissions, expiry and retention against real Postgres; Playwright covers upload, editing a row (remove Jamie), confirm, Cancel, duplicate re-upload and a non-uploader trying to confirm, on a phone and a desktop viewport with the model replaced by `LULLET_EXTRACTOR=stub`. The accuracy eval is manual: put redacted screenshots and golden files in a folder and run `pnpm eval:screenshots <folder>` (format in `scripts/eval-screenshots.ts`); it prints per-field accuracy and "silent errors" for Haiku and Sonnet side by side, and does nothing without an API key.

## Dashboard, budgets and daily rates

Routes: `/dashboard` (trip so far against the budget, a day by day chart, each person's share, by category), `/dashboard/[day]` (one day: its total, each person's share, categories and the expenses on it), `/budget` (the daily budget, budgets for single days, the trip's dates and time zone) and `/rates` (default exchange rate per currency per day).

- **What is counted.** Everything is in SGD through the usual rate precedence, and the totals are the ledger's: the sum of the days, of the members and of the categories all equal the group total on `/expenses`. A person's figure is their share of each expense, not who paid. Expenses with no exchange rate yet are left out and flagged, never guessed. `buildDashboard` in `src/lib/dashboard/aggregate.ts` is the one place that buckets, and `tests/integration/dashboard-store.test.ts` checks it against `summariseLedger`.
- **Days.** A day is the date written on the expense, never shifted by a time zone. The trip's time zone (default `Europe/Zurich`, set on `/budget`) only decides which day is today. The days shown are the trip's first to last day when set, otherwise the days that have expenses up to today, and always include every day with an expense so totals cannot drift from the ledger.
- **Budget.** One daily budget for the group, overridable for any day (`budgets` table, SGD). The meter is green under 80%, amber from 80% up to 100% and red above 100%, and always says so in words. Each person's share is compared with the day's budget divided by the members (spare cents go to the first members in the fixed order, so the slices add up). "So far" means the days up to today in the trip's time zone, and only days that have a budget count towards the budget side.
- **Daily rates.** An amount that is converted records the rate it was priced with (the day's rate if one is set, else the stored market rate) when it is saved, so saving or removing a day's rate never moves an existing expense, balance, settle-up or dashboard figure (`priced_rate`, `priced_rate_currency` and `priced_source` on expenses and settlements, kept apart from a rate typed on the expense; the migration fills them in from what each row was priced at, so nothing on screen changes). Instead `/rates` offers "Re-price N expenses on this day" (expenses and settlements together; a day with only a rate-priced settlement has an offer too): it moves only the records the day's rate decides, to the day's current rate or to the market rate when none is set, fetching and storing the market rate first if it was never stored. An expense billed in SGD, native SGD, or with a rate of its own keeps its figure and is not counted in N. Re-pricing runs in one transaction and writes an `audit_log` row for the day plus one `expense.reprice` or `settlement.reprice` row per record whose SGD figure moved, with the old and new figure and how each was decided; the expense's history page shows them. Saving or removing a rate itself only writes its own `audit_log` row. Editing an expense keeps the rate it was priced with unless the edit changes what the price depends on (its day, the currency being converted, or whether a rate prices it at all), in which case it takes the rate of that moment; the stored rate is part of the edit's history entry, so any move shows. Restoring a deleted expense keeps its figure.
- **Charts** are hand written HTML and CSS (`src/components/dashboard/day-chart.tsx`), not a library: nothing extra ships to the phone, text stays crisp at any width, and every colour comes from the theme tokens in `globals.css` so light and dark agree. One colour per category in a fixed order (the validated data-viz palette, never repainted by rank), a legend, a text equivalent (the day list under the chart) and state shown in words as well as colour.

## Telegram bot

Telegram is where screenshots are sent and edited; the web app stays the database and dashboard. The bot is a webhook at `POST /api/telegram/webhook` (grammY for the Bot API), code in `src/server/telegram` (handlers, Bot API adapter, notifications) and `src/lib/telegram` (pure logic: update routing, captions, callback data, message rendering).

**Who it answers.** One group chat (`TELEGRAM_GROUP_CHAT_ID`) and private chats, and only for the four members: the allowlist is the same `telegram_links` table that signs people in (filled by `pnpm auth:bootstrap`). Anyone else, any other chat, other bots and every other kind of update are ignored without a reply, and Telegram is always answered `200` so the URL looks dead. Every call must carry the `X-Telegram-Bot-Api-Secret-Token` header, compared in constant time with `TELEGRAM_WEBHOOK_SECRET` (`401` otherwise; `404` while the bot is not configured). Each update id is claimed once (`telegram_updates`), so a redelivery is not handled twice.

**After the response.** The webhook checks and acknowledges an update, then does the work (download, model read, replies) through `deferAfterResponse` in `src/server/telegram/runtime.ts`, which is Next's `after()` on Vercel (kept alive up to `maxDuration`, 180 s). The core (`handleWebhook`, `processUpdate`) takes a plain `defer` function, so another host needs only a different one-line binding.

**Sending a screenshot.** Any photo (or image sent as a file) in the private chat with the bot is read. In the group a photo counts only when its caption is a command (`/split`) or mentions the bot; the draft is then sent to the sender privately and the group sees only a short note and, later, the confirmed result (decision D2). The bot answers at once with "Reading your screenshot..." and edits that same message into the draft summary when the read finishes:

1. The summary lists each row (merchant, amount, category, a "check" or "needs input" mark, who shares when it differs), who paid, the total and each person's share, with buttons **Confirm N**, **Edit rows**, **Open in app** and **Cancel**. Confirm is offered only for a clean draft: 10 rows or fewer, no unreadable row, no possible duplicate, nothing that would fail to add. Anything else goes to **Open in app**. A message is capped at 4096 characters, so a long row list ends with a pointer to the app.
2. **Edit rows** edits the message in place, one row at a time: include or leave out the row, per-row member toggles, Equal / Percent (5% buttons, or reply to the message with percentages like `60 40`, `60,40` or `60/40`, only a dot is a decimal point; leave the last one out and that person takes the remainder), category, who paid, Prev / Next and Summary.
3. **Confirm** adds the rows to the ledger (one transaction, idempotent) and turns the message into the result with an **Undo** button; **Undo** removes the whole batch again. The group gets a short announcement of a confirmation.
4. **Open in app** opens the review page as a Mini App (`/signin?next=/imports/<id>`): the page signs the member in from Telegram's signed launch data and continues to the review screen.

Buttons carry only a short action code, the draft id and an HMAC nonce (under 64 bytes). The server rejects data it did not mint, and checks for every tap that the tapper is the uploader (anyone else gets "Only X can do that with this import."), that the draft is still open, and that nothing is added twice.

**Captions.** A caption such as `split between mei and dad`, `paid by mum` or `except dad` sets who paid and who shares. Plain code reads it (the text never reaches the model) against an alias table: each member's display name, first name and Telegram username, any extra names added with `/alias`, and `me`. Unknown names are reported in the draft, never guessed.

**Commands.** `/rate EUR 1.51` sets today's default rate for the group (SGD per 1 EUR; audited); `/login` sends the member a one-time dashboard link privately (always to their own chat, also when asked for in the group); `/alias mum mom` gives a member another name for captions (refused when the name is already someone's name, username or alias); `/help`.

**Notifications (decision D6).** Confirming an import or adding an expense on the web posts a short summary to the group; editing or deleting an expense, or undoing an import, sends a private message to each member who was part of it. All best effort: a member who never pressed Start in the bot, or Telegram being down, never fails the change.

**Setting it up.** The step by step version for the owner is [docs/LAUNCH.md](docs/LAUNCH.md). Create the bot with BotFather, add it to the group, and set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`), `TELEGRAM_GROUP_CHAT_ID` and `APP_URL` (public https) in the environment, plus `pnpm auth:bootstrap` for the four members. Then:

```sh
pnpm telegram:setup --dry-run   # print the webhook, Mini App address and commands, call nothing
pnpm telegram:setup             # setWebhook (with the secret token), setMyCommands, setChatMenuButton
```

Each member presses Start in a private chat with the bot once, so it can message them. Keep privacy mode on (the BotFather default): the bot only needs commands, replies and private chats. Whether a photo caption starting with a command reaches a bot under privacy mode is the open spike from the design (section 5.2); mentioning the bot in the caption is the alternative, and the private chat never depends on it.

**Tests.** Unit tests (`src/lib/telegram`, `src/server/telegram`) cover update routing and the allowlist, callback data and nonces, caption parsing, percentages, and rendering including the 4096 cap. Integration tests (`tests/integration/telegram-*.test.ts`) run the bot against real Postgres and a fake Bot API server (`src/test-support/fake-telegram.ts`, which also enforces the 4096 cap). Playwright (`tests/e2e/telegram.spec.ts`) POSTs simulated updates to the running app's webhook: photo, draft, edit a row, confirm, undo, non-uploader Confirm rejected, unknown users and chats ignored, `/rate`, `/login`, the Mini App launch and the notifications. Nothing calls a real bot or the network; set `E2E_FAKE_TELEGRAM_PORT` if the default (`PORT` + 11) is taken.

## Hardening and deployment

The launch runbook for the owner is [docs/LAUNCH.md](docs/LAUNCH.md); backups are in [docs/BACKUPS.md](docs/BACKUPS.md).

- **Vercel** (`vercel.json`): framework and build command, functions in `fra1` (next to the Neon database in Frankfurt), and one Vercel Cron entry, `/api/cron/retention` once a day (the Hobby plan allows nothing more frequent). A unit test fails if a route under `/api/cron` has no schedule. The routes that read screenshots set `maxDuration = 180` (uploads, re-reads, the Telegram webhook, whose deferred work runs inside it through `after()`), and the Claude client's timeout and retry (`REQUEST_TIMEOUT_MS`, `MAX_RETRIES`) (60 s per attempt, one retry) leave headroom inside that, which is under the 300 s that the Hobby plan allows with Fluid compute. Core code stays host agnostic: the only host binding is `deferAfterResponse` in `src/server/telegram/runtime.ts`.
- **Migrations are a deliberate step**, never run on a cold start: `pnpm db:migrate:prod` uses `DATABASE_URL_UNPOOLED` only, refuses a Neon pooler address, prints the host and database (no password) and supports `--dry-run`. The build does not touch the database.
- **First-run data**: `pnpm auth:bootstrap` creates the group and the four members with their Telegram ids (it refuses to run twice). `pnpm db:seed` is for local development only and refuses a non-local database.
- **Limits** (all enforced on the production paths, with tests): uploads are capped at 4 MB on the web route (before the body is read, and again on the file) and in the bot (by the size Telegram reports and again on the downloaded bytes); each person gets `IMPORT_DAILY_LIMIT` (30) uploads a rolling day on both paths, checked before any model call; a screenshot can be re-read twice; the webhook body is capped at 1 MB and needs the secret token; the retention route needs `CRON_SECRET`.
- **Security headers** for every response come from `src/lib/security-headers.ts` through `next.config.ts`: a Content Security Policy that allows only this site (inline scripts and styles are allowed because Next.js writes its own; no other origin can be loaded), `frame-ancestors` limited to this site and Telegram's web clients (so the Mini App works and nobody else can frame the app), `nosniff`, `Referrer-Policy: no-referrer` (login links carry a token in the address), a Permissions Policy and HSTS. Development skips the policy and HSTS.
- **Logs** carry the kind of failure only (`error.name`, `describeFailure`): never a screenshot, a model reply, a request body, a token or a connection string. `src/server/logging.test.ts` fails if server code logs a caught error object or a variable named like a secret.

## Layout

```
src/app            Next.js routes: (app) pages that need a session, expenses, balances, settlements, dashboard, budget, rates, /imports, /signin, /api/auth, /api/imports, /api/telegram, /api/cron, /api/health, server actions
src/proxy.ts       First gate: no session cookie, no protected page
src/components     UI building blocks (app shell, forms, rows, icons); import/ holds the upload and review screens
src/db             Drizzle schema, client, migration runner and guard, and the dev seed
src/lib/auth       Telegram sign-in: init data check, login links, sessions (db/ holds the database code), getSession
src/lib/ledger     Pure ledger logic: form validation, pricing, balances, audit diffs, formatting
src/lib/dashboard  Pure dashboard logic: day bucketing, budget maths, re-pricing, trip range, chart scales, form validation
src/lib/money      Money and ledger library
src/lib/config     The table of environment variables and the production start-up check
src/lib/export     CSV writing and the ledger export files
src/lib/fx         Exchange rate client
src/lib/import     Screenshot import logic: image checks, extraction schema, doubt states, duplicates, splits, drafts
src/lib/telegram   Bot logic with no I/O: update routing and allowlist, callback data, captions, message rendering
src/server         Group-scoped data access layer and per-request store; import/ holds screenshot storage, the model client, drafts and the retention job; telegram/ holds the bot
scripts            db:seed, db:migrate:prod, auth:bootstrap, auth:mint-link, eval:screenshots, telegram:setup, check:env and export:csv
docs               LAUNCH.md (owner runbook), ENVIRONMENT.md (every variable), BACKUPS.md
src/test-support   Shared test generators
tests/integration  Postgres integration tests
tests/e2e          Playwright specs
tests/fixtures     Recorded API responses
drizzle            Generated and hand written SQL migrations
```
