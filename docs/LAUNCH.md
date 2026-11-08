# Launching lullet

This is the step by step guide for putting lullet on the internet for the first time, written for
the owner, not for a programmer. Follow the parts in order and tick them off. Nothing here costs
money: every service has a free plan that is plenty for four people. Plan on about an hour.

**What you will end up with**

- The app on **Vercel** (Hobby plan), at an address like `https://lullet-family.vercel.app`.
- The ledger in **Neon** (free Postgres), in Frankfurt.
- Original screenshots kept briefly in the same Neon database: only while you review a draft, and
  deleted the moment the import is added or discarded. No other account is needed for them.
- A **Telegram bot** the four of you talk to, and that opens the app inside Telegram.
- Screenshots read by **Claude** through your own Claude Console API key (pay as you go; a few
  cents for a whole trip).

**Words used below**

- _Secret_: a password-like value. Never paste one into a chat, an email, a screenshot or GitHub.
- _Terminal_: the app on your computer where you type commands. On a Mac, open "Terminal".
- _Project folder_: the folder on your computer that holds this code.

---

## Part 0. Before you start

1. You need a computer with **Node 24** and **pnpm 12** (see the README, "Getting started"), and
   this project downloaded (`git clone`) with `pnpm install` done.
2. Each of the four people needs a **Telegram account** and must tell you their **numeric Telegram
   id**. To find it, they open Telegram, search for the bot `@userinfobot`, press Start, and it
   replies with `Id: 123456789`. Write down the four numbers with the names.
3. Decide who the **owner** is (you). The owner is the first person you list in step 5.1 and is
   the one who can re-link someone's Telegram later.

### 0.1 Make your private settings file

All the values you collect below go into one file on your computer, so you can check them in one
go. In the project folder:

```sh
cp .env.example .env.production.local
```

Open `.env.production.local` in a text editor and **delete everything in it**, then paste this
template. You will fill the blanks as you go.

```sh
DATABASE_URL=
DATABASE_URL_UNPOOLED=
DATABASE_POOL_MAX=1
SESSION_SECRET=
APP_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_GROUP_CHAT_ID=
ANTHROPIC_API_KEY=
CRON_SECRET=
```

When you run the commands below, a line like `.env not found. Continuing without it.` is normal and harmless.

This file is private: git ignores it, so it can never be committed by accident. Do not email it,
and delete it when the launch is done (part 9). The full explanation of each value is in
[ENVIRONMENT.md](ENVIRONMENT.md).

### 0.2 Make the three secrets you invent

In the terminal, run these three commands. Each prints one long random value. Paste the first
into `SESSION_SECRET`, the second into `TELEGRAM_WEBHOOK_SECRET` and the third into `CRON_SECRET`
in your file.

```sh
openssl rand -base64 48
openssl rand -hex 32
openssl rand -hex 32
```

---

## Part 1. The Telegram bot

1. In Telegram, open a chat with `@BotFather` (the official bot with a blue tick).
2. Send `/newbot`. Give it a display name (for example `lullet`) and a username that ends in
   `bot` (for example `lullet_family_bot`).
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Copy it into
   `TELEGRAM_BOT_TOKEN` in your file. Treat it like a password.
4. Leave the other BotFather settings as they are. In particular keep **privacy mode** on (the
   default); lullet does not need to read every message in the group. In the group, a screenshot
   is picked up when its caption starts with `/import` (Telegram does not pass the bot a caption
   that only mentions it).
5. Create a Telegram **group** with the four of you (or use your existing family group) and add
   the bot to it.
6. Find the group's id. In the group, send `/help@lullet_family_bot` (use your bot's username).
   Then, in a web browser, open this address with your token filled in:

   `https://api.telegram.org/bot<YOUR TOKEN>/getUpdates`

   Look for `"chat":{"id":-100...` and copy the whole number, minus sign included, into
   `TELEGRAM_GROUP_CHAT_ID`. If you see nothing, send another message in the group and reload.
   Do this **before** step 7.3; once the bot is registered this page stops working.

---

## Part 2. The database (Neon)

1. Go to <https://neon.com> and sign up (the free plan needs no card).
2. Create a project. Name it `lullet`. For the region choose **AWS Europe (Frankfurt)**. The region
   cannot be changed later, and the app is set up to run in Frankfurt (`vercel.json`).
3. On the project page press **Connect**. You will see a connection string and a switch called
   **Connection pooling**.
   - With pooling **on**, the host contains `-pooler`. Copy that string into `DATABASE_URL`.
   - Switch pooling **off**. The host no longer contains `-pooler`. Copy that string into
     `DATABASE_URL_UNPOOLED`.
4. Both strings contain your database password. They are secrets.

Why two? The running app uses the pooled one (it copes with many short connections). Changes to
the database structure go through the direct one, in a deliberate step you run yourself (part 5).
The app never changes the database structure on its own.

---

## Part 3. Screenshot storage (nothing to do)

There is nothing to set up here. While you review a draft, the app keeps the screenshot in your
Neon database so it can show it next to the amounts it read, and deletes it as soon as the import is
added or discarded (drafts that nobody finishes are cleaned up after 24 hours). A screenshot is
never larger than 4 MB, so this stays tiny next to Neon's free 0.5 GB.

_Optional, only if you ever want it:_ original screenshots can go to a private Cloudflare R2 bucket
instead. Set all four of `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`
(see [ENVIRONMENT.md](ENVIRONMENT.md)) and the app uses it; leave all four empty to keep the
default.

---

## Part 4. The screenshot reader (Claude)

1. Go to <https://console.anthropic.com> and sign in or create an account.
2. Add a small amount of credit (billing page). Set a monthly spend limit if you like.
3. **API keys**, then **Create key**. Name it `lullet`. Copy the key (it starts with `sk-ant-`) into
   `ANTHROPIC_API_KEY`.

Without this key the app still works, but every screenshot comes out as an empty draft, so the
check in the next step insists on it.

### 4.1 Check everything so far

In the terminal, in the project folder:

```sh
pnpm check:env
```

It lists every setting as `ok`, `PROBLEM` or `not set`, and never prints a value. `APP_URL` is
still empty, so it will complain about that one only; you fill it in next. Fix anything else it
names before going on.

---

## Part 5. Deploy the app (Vercel)

1. Go to <https://vercel.com> and sign up with your GitHub account (the Hobby plan is free).
2. **Add New**, then **Project**, and import the `lullet` repository.
3. On the setup screen, set **Project Name** to something you like, for example `lullet-family`.
   The app's address will be `https://<project name>.vercel.app`. Put exactly that into `APP_URL`
   in your file (no slash at the end), then run `pnpm check:env` again; it should now say
   `All production settings look right.`
4. On the same screen open **Environment Variables**. Click into the first name box and **paste the
   whole contents of `.env.production.local`**; Vercel fills in all the rows. Remove the
   `DATABASE_URL_UNPOOLED` row (the live app does not need it), then check that each row is applied
   to **Production**.
5. Press **Deploy**. It takes a couple of minutes.
6. When it finishes, open `https://<project name>.vercel.app/api/health`. You should see
   `{"status":"ok"}`.

If the deploy shows an error or the address says "500", open the project on Vercel, **Logs**, and
look for `lullet cannot start`. It lists exactly which settings are missing or wrong, by name, never
by value. Fix them under **Settings, Environment Variables**, then **Deployments**, the newest one,
**Redeploy**.

Vercel will also try to build branches and pull requests ("Preview" deployments). They have no
settings and will report errors; ignore them.

---

## Part 6. Create the tables and add the four of you

Do these once, from the terminal on your computer. Both read your `.env.production.local`.

### 6.1 Create the tables (migrations)

```sh
pnpm db:migrate:prod --dry-run     # says how many steps are waiting; changes nothing
pnpm db:migrate:prod               # does them
```

Each command prints `Database: <host>/<name>` first. Check it is your Neon host. If the command
says your address "points at Neon's pooler", you pasted the pooled string into
`DATABASE_URL_UNPOOLED`; use the one with pooling switched off.

Whenever the app is updated with a new database change, run the same two commands **before**
deploying that update.

### 6.2 Add the group and the four members

Use your own names and the four numeric Telegram ids from part 0. The **first** member is the
owner, and the order you list them in is permanent (it decides who gets the spare cent when an
amount does not divide evenly), so choose it once:

```sh
pnpm auth:bootstrap --group "Switzerland and Italy" \
  --member "Veleon=111111111" \
  --member "Mei=222222222" \
  --member "Mum=333333333" \
  --member "Dad=444444444"
```

It prints `Created group ... with 4 members`. It refuses to run a second time, so a repeat cannot
create a second group. If you typed a wrong id, the owner can fix it later on the app's **Members**
page.

---

## Part 7. Switch the bot on

1. Print what will be registered, calling nothing:

   ```sh
   pnpm telegram:setup --dry-run
   ```

   Check the webhook address is `https://<project name>.vercel.app/api/telegram/webhook`.

2. Register it:

   ```sh
   pnpm telegram:setup
   ```

   It checks the bot token first, then registers the webhook with its secret, the command list
   (`/import`, `/rate`, `/login`, `/alias`, `/help`) and the **Open lullet** button, and prints the bot's
   username and how many updates are waiting. It is safe to run again whenever you like, for
   example after changing the address.

3. Each of the four people opens a private chat with the bot and presses **Start** once. This is
   what lets the bot message them privately.

---

## Part 8. Smoke test

Do these three, in this order, on your own phone. If one fails, stop and see "If something goes
wrong" at the end.

**A. Sign in.**

1. In the private chat with the bot, send `/login`. It replies with a link.
2. Open the link and press **Continue**. You should land in the app, signed in with your name.
3. Also try the **Open lullet** button next to the message box in the bot chat. It should open the
   app inside Telegram, already signed in.
4. Open **Budget** and set the trip's first and last day and the daily budget.

**B. Add an expense by hand.**

1. In the app, add an expense (for example "Test coffee", 4.50 CHF, paid by you, split equally).
2. The group chat should get a short message about it. Open **Balances** and check the numbers.
3. Open the expense and delete it, so the real ledger starts clean. (Deleted expenses stay in the
   history and in exports; that is intended.)

**C. Send a screenshot.**

1. Send a screenshot of a receipt or card payment to the bot in the private chat.
2. It answers "Reading your screenshot..." and then turns that message into a draft with
   **Confirm**, **Edit rows**, **Open in app** and **Cancel**.
3. Press **Cancel** (or Confirm and then **Undo**) so nothing stays in the ledger.
4. Also try it in the family group: send a screenshot with the caption `/import`. The group shows a
   short note and the draft arrives in your private chat. (A caption that only says the bot's
   name is not seen by the bot.)

**D. Check the daily clean-up (once).** On Vercel, **Settings, Cron Jobs** should list
`/api/cron/retention`. To run it by hand, put your `CRON_SECRET` in this command (it should print
four numbers, all zero on day one):

```sh
curl -X POST -H "Authorization: Bearer <your CRON_SECRET>" https://<project name>.vercel.app/api/cron/retention
```

Without the header it must answer `401`.

When all of this works, you have launched. Ask the other three to press Start and try `/login`.

---

## Part 9. Tidy up

- Delete `.env.production.local` from your computer if you do not need it again (you can recreate it
  from Vercel's settings and your password manager). Better still, keep the values in a password
  manager, not in a file.
- Take a first backup export (see [BACKUPS.md](BACKUPS.md)).
- Note the date and place of every secret in a password manager: the Neon, Claude, Vercel and
  Telegram logins.

---

## Day to day

- **Change a setting**: Vercel, Settings, Environment Variables, edit, then redeploy the latest
  deployment (settings are read at deploy time).
- **Update the app**: merge to `main`; Vercel deploys it. If the update changes the database, run
  `pnpm db:migrate:prod` first (part 6.1).
- **Logs**: Vercel, project, **Logs**. Logs name the kind of failure only. They never contain
  screenshots, model replies, tokens or passwords.
- **Free plan limits to know**: Vercel Hobby is for personal, non-commercial use; Neon's free
  database sleeps when idle and wakes in about a second; each person may upload 30 screenshots a
  day (`IMPORT_DAILY_LIMIT`), each up to 4 MB.

## Backups

See [BACKUPS.md](BACKUPS.md). In short: Neon keeps a short rewind window on the free plan, so also
run `pnpm export:csv` before the trip and about once a week during it.

## Rolling back

Pick the case that matches.

**The new version of the app is broken** (the database is fine). Vercel, project, **Deployments**.
Find the last good one, open its menu and choose **Instant Rollback** (or **Promote to
Production**). Done in seconds. Then fix the problem in the code and deploy again.

**A setting is wrong.** Fix it under Environment Variables and redeploy. The previous values are
not kept, so keep your own copy in a password manager.

**A database change went wrong.** Migrations only ever add (new tables or columns) and are never
undone automatically. Prefer fixing forward. If data was damaged, restore from Neon's rewind
window, or from an export (see [BACKUPS.md](BACKUPS.md)). Do not restore without asking whoever
maintains the code.

**The bot misbehaves.** Stop it from calling the app by running this once, with your token
(the app keeps working on the web):

```sh
curl "https://api.telegram.org/bot<YOUR TOKEN>/deleteWebhook"
```

Turn it back on with `pnpm telegram:setup`.

**A secret leaked.** Replace it: make a new value (BotFather `/revoke`, Claude key delete and
recreate, or a new `openssl` value), update Vercel, redeploy. For a
new `SESSION_SECRET` everyone is signed out and signs in again with `/login`. For a new
`TELEGRAM_WEBHOOK_SECRET`, run `pnpm telegram:setup` again.

## If something goes wrong

| What you see                                               | What to do                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The site shows an error and Logs say `lullet cannot start` | A setting is missing or wrong; the log names it. Fix it in Vercel, redeploy.                                                |
| `/login` gets no answer from the bot                       | Run `pnpm telegram:setup` again and read its last line. Check `APP_URL`, and that the webhook secret is the same in Vercel. |
| "This Telegram account is not on the list"                 | The numeric id given in step 6.2 is wrong. The owner fixes it on the **Members** page.                                      |
| Screenshots come back as empty drafts                      | `ANTHROPIC_API_KEY` is missing, wrong or out of credit. Check the Claude Console.                                           |
| "That file is too large"                                   | Limit is 4 MB. Take a screenshot instead of a camera photo.                                                                 |
| "You have reached today's limit"                           | 30 screenshots per person per day. Try tomorrow or raise `IMPORT_DAILY_LIMIT`.                                              |
| `pnpm check:env` complains about a value                   | It says which one and why; it never shows the value. Re-copy it from the service.                                           |
| Pages are slow after being idle                            | Neon's free database wakes from sleep; the first request takes a second or two.                                             |
