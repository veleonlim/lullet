# lullet

Europe Split: a Splitwise-like expense splitter for four people (the requester, their girlfriend and their parents), first used on a trip to Switzerland and Italy.

Telegram is the capture and edit surface; this web app is the database and dashboard. This repository holds the foundation (app skeleton, database schema, the money and ledger library, the quality gates), Telegram sign-in, and the web ledger: expense list, add and edit, soft delete and restore, history, balances and settle-up. Later slices add the Telegram bot, screenshot import and the dashboard.

## Stack

| Area     | Choice                                                                           |
| -------- | -------------------------------------------------------------------------------- |
| App      | Next.js (App Router), React, TypeScript (strict), Tailwind CSS                   |
| Database | PostgreSQL 18, Drizzle ORM and drizzle-kit migrations, `pg` (node-postgres)      |
| Tests    | Vitest, fast-check (property tests), Playwright (phone and desktop projects)     |
| Tooling  | pnpm, ESLint (typescript-eslint strict), Prettier                                |
| CI       | GitHub Actions                                                                   |
| Hosting  | Planned: Vercel Hobby, Neon Postgres, Cloudflare R2. Deployment is a later slice |

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

| Script                         | What it does                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `build` / `start` | Next.js development server, production build, production server                                                                     |
| `pnpm check:static`            | typecheck, ESLint and Prettier check (what `.no-mistakes.yaml` runs as `lint`)                                                      |
| `pnpm typecheck`               | `tsc --noEmit`                                                                                                                      |
| `pnpm lint`                    | ESLint                                                                                                                              |
| `pnpm format` / `format:check` | Prettier write / check                                                                                                              |
| `pnpm test`                    | Unit and property tests (no external services; what `.no-mistakes.yaml` runs as `test`)                                             |
| `pnpm test:coverage`           | Same, with coverage thresholds on `src/lib`                                                                                         |
| `pnpm test:integration`        | Integration tests against real Postgres; needs `DATABASE_URL`                                                                       |
| `pnpm test:e2e`                | Playwright on a phone and a desktop viewport; needs Postgres (`DATABASE_URL`)                                                       |
| `pnpm db:seed`                 | Create a dev group with four members linked to Telegram ids 5100001 to 5100004; `--reset` empties the ledger, `--demo` adds samples |
| `pnpm auth:bootstrap`          | Create the group and link its members to Telegram accounts (once)                                                                   |
| `pnpm auth:mint-link`          | Print a one-time browser login link for a member                                                                                    |
| `pnpm db:generate`             | Generate a migration from schema changes                                                                                            |
| `pnpm db:migrate`              | Apply migrations to `DATABASE_URL_UNPOOLED` or `DATABASE_URL`                                                                       |
| `pnpm db:check`                | Verify the migration history is consistent                                                                                          |

`pnpm test:e2e` starts `pnpm dev` itself on port 3100 (or reuses a server already running there). With `CI=1` it serves the production build instead, so run `pnpm build` first. The suite uses its own database, `lullet_e2e`, created and migrated on the server `DATABASE_URL` points at, seeds the four ledger members (`src/db/seed-ids.ts`) and signs in through the real login-link flow, and its own made-up secrets and bot token; no real Telegram bot is involved.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as separate jobs:

1. **Static checks**: typecheck, ESLint, Prettier, and that the committed migrations match the schema.
2. **Unit and property tests** with coverage thresholds.
3. **Integration tests** against a `postgres:18` service container.
4. **Build**: `next build`.
5. **Playwright** on the production build, phone and desktop projects, against a Postgres service container.

No job calls a live external service; exchange rate tests replay recorded responses.

## Environment and secrets

`.env.example` lists every variable, with the ones not needed yet as commented placeholders. Secrets come only from the environment (Vercel project settings in production, `.env` locally, never committed). Nothing external has been created yet: the accounts and keys below are owned by the captain and are set up when the slice that needs them starts. Tests never need a real bot or real secrets.

| Variable                                                               | Needed by | What it is                                                                                               |
| ---------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                         | now       | Postgres connection. In production, Neon's pooled connection string                                      |
| `DATABASE_URL_UNPOOLED`                                                | now       | Optional. Neon's direct connection, preferred for migrations                                             |
| `DATABASE_POOL_MAX`                                                    | now       | Optional. Connections per instance, default 5; use 1 on serverless                                       |
| `SESSION_SECRET`                                                       | now       | At least 32 characters. Keys the hash of session cookies and login links; changing it signs everyone out |
| `APP_URL`                                                              | now       | Public origin (`https://...`), used to build login links. Required in production                         |
| `TELEGRAM_BOT_TOKEN`                                                   | now       | Bot token from BotFather. Verifies Mini App sign-in; also used by the bot (slice 3)                      |
| `TELEGRAM_WEBHOOK_SECRET`                                              | slice 3   | Secret token checked on every webhook call                                                               |
| `ANTHROPIC_API_KEY`                                                    | slice 4   | Claude Console API key for screenshot extraction                                                         |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | slice 4   | Cloudflare R2 (S3 compatible) private bucket for original screenshots                                    |
| `CRON_SECRET`                                                          | slice 7   | Protects scheduled jobs such as the 30 day screenshot deletion                                           |

## Sign in with Telegram

Only four allowlisted Telegram users can use the app (decision D3). Everyone else gets no session and no data. Code is in `src/lib/auth/`; there are no passwords.

**The allowlist** is the `telegram_links` table: a Telegram user id is served only if it is linked to a member of the group. `pnpm auth:bootstrap` creates the group and its members (the first `--member` is the owner; the order is the group's fixed member order) and refuses to run twice. After that the owner re-links a member from the **Members** page (for example when someone loses their Telegram account). A re-bind signs the member's old sessions and unused login links out, and writes an `audit_log` row.

**Two ways in**

- **Mini App** (inside Telegram): the page reads the signed launch data (`tgWebAppData`) and posts it to `POST /api/auth/telegram`. The server checks it as Telegram documents ([Mini Apps: validating data](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)): HMAC-SHA256 with the key `HMAC_SHA256("WebAppData", bot token)` over the sorted `key=value` fields, compared in constant time, and `auth_date` no older than one hour. The Telegram user id must then be on the allowlist.
- **Browser**: the bot (a later task) sends a one-time link. `mintLoginLink(telegramUserId)` in `src/lib/auth/db/login-links.ts` is the function it calls; it returns `null` for anyone not on the allowlist, and otherwise a URL `APP_URL/signin/link/<token>`. The token is 256 random bits, stored only as an HMAC hash, valid for 10 minutes, and used up by one atomic conditional `UPDATE`, so it works once even under concurrent requests. Minting a new link withdraws the member's older unused one. Opening the link only shows a **Continue** button (`POST /api/auth/link` consumes it), because Telegram fetches URLs in messages to build previews and a plain GET would burn the link. The sign-in page tells people to send `/login` to the bot; that is the contract for the bot task.

Until the bot exists, mint a link yourself: `pnpm auth:mint-link <telegram-user-id>` prints the URL (it works against production too if `DATABASE_URL`, `SESSION_SECRET` and `APP_URL` point there).

**Sessions** are server side (`sessions` table). The cookie `__Host-lullet_session` is `httpOnly`, `Secure`, `SameSite=Lax`, path `/`, and holds only a random token; the table stores its HMAC hash. A session lasts 30 days. Every login issues a new token and destroys the one the browser held (no session fixation); logout deletes the row, so a copied cookie stops working. A session also ends when the member leaves the group or the allowlist. The two cookie-setting POST routes refuse cross-site requests (`Sec-Fetch-Site` or `Origin`).

**Guarding pages**: `src/proxy.ts` sends cookie-less requests to `/signin` (and answers `401` for `/api/*`), and the `(app)` route group's layout checks the session for real. Pages, server actions and route handlers learn who is calling only through `getSession()` in `src/lib/auth/session.ts`, which returns `{ userId, groupId }` or `null`; the data access layer scopes every query by that `groupId`. `/api/health` and the sign-in routes are public.

Not done here: rate limiting of the public auth routes (slice 7), and the bot itself.

## Database

Schema lives in `src/db/schema/` and migrations in `drizzle/`. Run `pnpm db:generate` after changing the schema and commit the result; CI fails if the migrations and schema disagree.

Tables: `users`, `groups`, `memberships` (with `is_owner`, at most one owner per group), `expenses`, `expense_payers`, `expense_shares`, `settlements`, `imports`, `import_rows`, `fx_rates` (stored market rates), `daily_rates` (per day default rate overrides), `budgets`, `audit_log`, `telegram_links`, `sessions` and `login_tokens`.

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
- **Exchange rates**: the SGD figure follows the library's precedence (shown in SGD, billed SGD, the expense's own rate, the group's day rate, the stored market rate). The first time a day needs a market rate it is fetched from Frankfurter and stored, so history never moves. If none can be fetched the form asks for a rate instead of guessing. Records without any rate are left out of the balances and flagged.
- **Soft delete and audit**: deleting only marks the row; every create, edit, delete and restore (expenses and settlements) writes an `audit_log` row in the same transaction, with the before and after, and the history page reads it back. Edits carry the version that was loaded, so overwriting someone else's change is refused.
- **Data access**: pages and server actions get the caller from `getSession()` and the ledger only from `openStore()` (`src/server/runtime.ts`, which sends a caller without a live session to `/signin`), which wraps the group-scoped store in `src/server/ledger/store.ts`. Every query there filters by the session's group (child tables and the audit log included), a user outside the group is refused, and ESLint stops `src/app` and `src/components` from importing the database. `tests/integration/ledger-scoping.test.ts` drives every store method with another group's ids and fails to compile when a method has no probe.

## Layout

```
src/app            Next.js routes: (app) pages that need a session, expenses, balances, settlements, /signin, /api/auth, /api/health, server actions
src/proxy.ts       First gate: no session cookie, no protected page
src/components     UI building blocks (app shell, forms, rows, icons)
src/db             Drizzle schema, client, migration runner and the dev seed
src/lib/auth       Telegram sign-in: init data check, login links, sessions (db/ holds the database code), getSession
src/lib/ledger     Pure ledger logic: form validation, pricing, balances, audit diffs, formatting
src/lib/money      Money and ledger library
src/lib/fx         Exchange rate client
src/server         Group-scoped data access layer and per-request store
scripts            db:seed, auth:bootstrap and auth:mint-link
src/test-support   Shared test generators
tests/integration  Postgres integration tests
tests/e2e          Playwright specs
tests/fixtures     Recorded API responses
drizzle            Generated and hand written SQL migrations
```
