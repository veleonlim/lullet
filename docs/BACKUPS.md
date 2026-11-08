# Backups

lullet keeps money records, so there are two independent safety nets. Use both.

## 1. Neon's built-in rewind (point in time restore)

Neon keeps a history of every change so a database can be rewound to any moment inside a window,
without any setup. On the **free plan the window is short**: Neon's documentation currently gives
**6 hours** (and at most 1 GB of change history); older pages and plans said 24 hours. Check the
number for your project in the Neon console (Settings, the restore or "history" window) before you
rely on it. Paid plans keep 7 to 30 days.

What this means in practice: rewind is for "I just broke something, undo the last hour", not for
"I noticed last week". For anything older, use the CSV export below.

**To rewind** (Neon console, your project, the **Backup & Restore** page; older consoles call it
**Restore** under Branches):

1. Pick the time just before the damage. The page shows the data as it was, so you can check.
2. Choose to restore. Neon first saves the current state as a backup branch, so a restore can
   itself be undone. Use that option, and never delete the backup branch until you are sure.
3. Afterwards check the app: balances, the latest expenses.

Tips:

- A restore changes the data in place and keeps the same connection strings, so nothing in Vercel
  needs changing.
- Soft-deleted expenses and settlements are not lost; they stay in the database marked as deleted,
  and the app's history page shows them. Often "restore" is only a click on that page.
- A restore drill against a real database was deliberately not run when this was set up. Before the
  trip, do a calm, five minute dry run yourself: in the Neon console create a **branch** of the
  database from a point a few minutes ago and open its **Tables** view. That proves the rewind
  window works without touching the real data. Delete the branch afterwards.

## 2. CSV export to your own computer

`pnpm export:csv` saves the whole ledger as spreadsheet files. It is read-only: it cannot change the
database.

```sh
pnpm export:csv                              # into exports/lullet-export-<date and time>/
pnpm export:csv --out ~/Documents/lullet-1   # into a folder you choose (must not exist yet)
```

It uses the settings in `.env.production.local` (see [LAUNCH.md](LAUNCH.md), part 0.1). It prints the
database it read from and the number of rows in each file.

Files written (open them in Excel, Numbers or Google Sheets):

| File                                             | Contents                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `groups.csv`                                     | The trip group, its dates and time zone                                                |
| `members.csv`                                    | Members in their fixed order, who is the owner, their Telegram ids                     |
| `expenses.csv`                                   | Every expense, deleted ones included (`deleted_at` filled in), who paid and who shared |
| `expense_payers.csv`, `expense_shares.csv`       | One row per payer and per share, with exact amounts                                    |
| `settlements.csv`                                | Every settle-up payment                                                                |
| `budgets.csv`, `daily_rates.csv`, `fx_rates.csv` | Budgets, the per-day rates you set, and the stored market rates                        |
| `audit_log.csv`                                  | The complete change history (who did what, with before and after)                      |

Amounts appear twice: as a normal decimal (`148.49`) and as exact whole minor units (`14849`), so
nothing is lost to rounding. Text that a spreadsheet could mistake for a formula is made safe with a
leading apostrophe.

Original screenshots are **not** in the export; they stay in the R2 bucket for 30 days after
confirmation and are then deleted on purpose. The extracted rows are kept.

**The files contain your family's spending and Telegram ids.** Keep them private: not in a shared
folder, not in an email. The folder is created readable by you only.

### When to export

- Once right after launch.
- Before you leave for the trip.
- About once a week during the trip, and on the last day.
- Before any risky change (a database update, a restore).

Keep the last few exports. Name or date the folders so you know which is which.

## 3. What a restore from a CSV means

The CSV is a faithful copy for reading, checking and for rebuilding by hand if everything else
fails; there is deliberately no import script, because loading data into a money ledger should be a
supervised, one-off job by whoever maintains the code. If you ever need it, keep the export folder
and ask.
