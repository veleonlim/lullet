# lullet

Europe Split: a Splitwise-like expense splitter for four people (the requester, their girlfriend and their parents), first used on a trip to Switzerland and Italy.

Telegram is the capture and edit surface; this web app is the database and dashboard. This repository currently holds slice 1, the foundation: app skeleton, database schema, the money and ledger library, and the quality gates. Later slices add the ledger UI, auth, the Telegram bot, screenshot import and the dashboard.

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
pnpm dev                      # http://localhost:3000
```

First time running end to end tests: `pnpm exec playwright install chromium`.

## Scripts

| Script                         | What it does                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `pnpm dev` / `build` / `start` | Next.js development server, production build, production server                         |
| `pnpm check:static`            | typecheck, ESLint and Prettier check (what `.no-mistakes.yaml` runs as `lint`)          |
| `pnpm typecheck`               | `tsc --noEmit`                                                                          |
| `pnpm lint`                    | ESLint                                                                                  |
| `pnpm format` / `format:check` | Prettier write / check                                                                  |
| `pnpm test`                    | Unit and property tests (no external services; what `.no-mistakes.yaml` runs as `test`) |
| `pnpm test:coverage`           | Same, with coverage thresholds on `src/lib`                                             |
| `pnpm test:integration`        | Integration tests against real Postgres; needs `DATABASE_URL`                           |
| `pnpm test:e2e`                | Playwright smoke tests on a phone and a desktop viewport                                |
| `pnpm db:generate`             | Generate a migration from schema changes                                                |
| `pnpm db:migrate`              | Apply migrations to `DATABASE_URL_UNPOOLED` or `DATABASE_URL`                           |
| `pnpm db:check`                | Verify the migration history is consistent                                              |

`pnpm test:e2e` starts `pnpm dev` itself (or reuses a running server). With `CI=1` it serves the production build instead, so run `pnpm build` first.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, as separate jobs:

1. **Static checks**: typecheck, ESLint, Prettier, and that the committed migrations match the schema.
2. **Unit and property tests** with coverage thresholds.
3. **Integration tests** against a `postgres:18` service container.
4. **Build**: `next build`.
5. **Playwright** on the production build, phone and desktop projects.

No job calls a live external service; exchange rate tests replay recorded responses.

## Environment and secrets

Slice 1 reads only the three database variables marked "now" below. `.env.example` lists every variable later slices will need, as commented placeholders. Nothing external has been created yet: the accounts and keys below are owned by the captain and are set up when the slice that needs them starts.

| Variable                                                               | Needed by | What it is                                                            |
| ---------------------------------------------------------------------- | --------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                                                         | now       | Postgres connection. In production, Neon's pooled connection string   |
| `DATABASE_URL_UNPOOLED`                                                | now       | Optional. Neon's direct connection, preferred for migrations          |
| `DATABASE_POOL_MAX`                                                    | now       | Optional. Connections per instance, default 5; use 1 on serverless    |
| `TELEGRAM_BOT_TOKEN`                                                   | slice 3   | Bot token from BotFather                                              |
| `TELEGRAM_WEBHOOK_SECRET`                                              | slice 3   | Secret token checked on every webhook call                            |
| `ANTHROPIC_API_KEY`                                                    | slice 4   | Claude Console API key for screenshot extraction                      |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | slice 4   | Cloudflare R2 (S3 compatible) private bucket for original screenshots |
| `SESSION_SECRET`                                                       | slice 2   | Signs session cookies                                                 |
| `CRON_SECRET`                                                          | slice 7   | Protects scheduled jobs such as the 30 day screenshot deletion        |

## Database

Schema lives in `src/db/schema/` and migrations in `drizzle/`. Run `pnpm db:generate` after changing the schema and commit the result; CI fails if the migrations and schema disagree.

Tables: `users`, `groups`, `memberships`, `expenses`, `expense_payers`, `expense_shares`, `settlements`, `imports`, `import_rows`, `fx_rates` (stored market rates), `daily_rates` (per day default rate overrides), `budgets`, `audit_log` and `telegram_links`.

Money is always an integer count of minor units (`4850` plus `EUR`), stored as `bigint`. The database itself enforces what it can, in `0000_core_schema.sql` and the hand written `0001_invariants.sql`:

- amounts are positive, currency codes are three capital letters, billed amount and currency come together
- payer amounts add up to the expense amount, and so do share amounts, checked at commit by deferred constraint triggers. An expense therefore has to be written together with its payers and shares in one transaction
- a payer, share, settlement party or uploader must belong to the group (composite foreign keys to `memberships`)
- expenses and settlements are soft deleted (`deleted_at` and `deleted_by` set together) and cannot be removed
- `audit_log` is append only and `fx_rates` rows never change, so history does not move
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

## Layout

```
src/app            Next.js routes (placeholder home page, /api/health)
src/components     UI building blocks (mobile first app shell)
src/db             Drizzle schema, client and migration runner
src/lib/money      Money and ledger library
src/lib/fx         Exchange rate client
src/test-support   Shared test generators
tests/integration  Postgres integration tests
tests/e2e          Playwright specs
tests/fixtures     Recorded API responses
drizzle            Generated and hand written SQL migrations
```
