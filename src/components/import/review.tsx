"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyEdit,
  cleanBatch,
  computeTotals,
  countedAmount,
  moneyText,
  FAILURE_TEXT,
  resolveSplit,
  rowToEdit,
  setBatchMode,
  setBatchPercent,
  setRowMode,
  setRowPercent,
  sumByCurrency,
  toggleBatchPayer,
  toggleBatchPercentMember,
  toggleRowMember,
  validateForConfirm,
  type BatchSplit,
  type DraftRow,
  type DraftView,
  type RowEdit,
} from "@/lib/import";
import { formatMoney, type FieldErrors, type Member } from "@/lib/ledger";
import { isCurrencyCode } from "@/lib/money";
import { route } from "@/lib/routes";
import { Avatar } from "../avatar";
import { ChipRadioGroup } from "../form-controls";
import { LocalTime } from "../local-time";
import { Button, Card, Notice, SectionTitle } from "../ui";
import {
  addRowRequest,
  ApiError,
  cancelRequest,
  confirmRequest,
  rereadRequest,
  saveDraftRequest,
} from "./api";
import { MemberChips, PercentInput } from "./member-chips";
import { RowCard } from "./row-card";

const MODEL_NAMES: Readonly<Record<string, string>> = {
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
};

type SaveState = "idle" | "saving" | "saved" | "error";
type Busy = "confirm" | "reread" | "cancel" | "row" | null;

function money(minor: number, currency: string): string {
  return isCurrencyCode(currency) ? formatMoney(minor, currency) : `${String(minor)} ${currency}`;
}

/** "€10.00 + CHF 5.00", or "Nothing" when there is nothing. */
function moneyList(byCurrency: Readonly<Record<string, number>>): string {
  const parts = Object.entries(byCurrency)
    .filter(([, minor]) => minor !== 0)
    .map(([currency, minor]) => money(minor, currency));
  return parts.length > 0 ? parts.join(" + ") : "Nothing";
}

export function ImportReview({
  view,
  members,
  currentUserId,
  openRowId,
}: {
  view: DraftView;
  members: readonly Member[];
  currentUserId: string;
  /** A row to open for editing as soon as the page shows (from a link in the chat). */
  openRowId?: string | undefined;
}) {
  const router = useRouter();
  const order = useMemo(() => members.map((m) => m.userId), [members]);
  const nameOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.displayName ?? "Someone";
  const readOnly = view.uploaderId !== currentUserId;

  const [batch, setBatch] = useState<BatchSplit>(view.batch);
  const [edits, setEdits] = useState<RowEdit[]>(() => view.rows.map(rowToEdit));
  const [base, setBase] = useState<readonly DraftRow[]>(view.rows);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, FieldErrors>>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notice, setNotice] = useState<{
    tone: "error" | "warning" | "success";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // Which row to open for editing: the row id and a counter, so asking twice opens it twice.
  const [focus, setFocus] = useState<{ id: string; count: number }>({
    id: view.rows.some((row) => row.id === openRowId) ? (openRowId ?? "") : "",
    count: view.rows.some((row) => row.id === openRowId) ? 1 : 0,
  });
  const [asking, setAsking] = useState<"cancel" | "reread" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const cleaned = useMemo(
    () => cleanBatch(batch, order, view.uploaderId),
    [batch, order, view.uploaderId],
  );
  const rows = useMemo(() => {
    const byId = new Map(edits.map((edit) => [edit.id, edit] as const));
    return base.map((row) => {
      const edit = byId.get(row.id);
      return edit ? applyEdit(row, edit) : row;
    });
  }, [base, edits]);
  const splits = useMemo(
    () => rows.map((row) => resolveSplit(cleaned, row.split, order)),
    [rows, cleaned, order],
  );
  const validation = useMemo(
    () => validateForConfirm(rows, cleaned, order),
    [rows, cleaned, order],
  );

  // What each payment counts for: the amount the bank charged when there is one, else the receipt.
  const going = rows.flatMap((row, index) => {
    const split = splits[index];
    const counted = countedAmount(row);
    return row.included && counted && row.amountMinor !== null && row.currency !== null && split?.ok
      ? [{ row, counted, split: split.split }]
      : [];
  });
  const totals = useMemo(
    () =>
      computeTotals(
        going.map(({ counted, split }) => ({
          amountMinor: counted.amountMinor,
          currency: counted.currency,
          split,
        })),
        cleaned.payerIds,
        order,
      ),
    // `going` is derived from rows, splits and cleaned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, splits, cleaned, order],
  );
  const countedSums = sumByCurrency(going.map(({ counted }) => counted));
  // The screenshot's own total is on the receipt amounts, so that comparison uses those.
  const sums = sumByCurrency(
    going.flatMap(({ row }) =>
      row.amountMinor !== null && row.currency !== null
        ? [{ amountMinor: row.amountMinor, currency: row.currency }]
        : [],
    ),
  );
  const screenTotal = view.screenTotal;
  const includedCount = rows.filter((row) => row.included).length;

  // ---- saving as you go -------------------------------------------------------------------
  const firstRender = useRef(true);
  const sequence = useRef(0);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (readOnly) return;
    const mine = ++sequence.current;
    const timer = setTimeout(() => {
      setSaveState("saving");
      saveDraftRequest(view.id, { batch, rows: edits }).then(
        (saved) => {
          if (mine !== sequence.current) return;
          setBase(saved.rows);
          setSaveState("saved");
        },
        (error: unknown) => {
          if (mine !== sequence.current) return;
          setSaveState("error");
          if (error instanceof ApiError && error.status === 410) router.refresh();
        },
      );
    }, 600);
    return () => {
      clearTimeout(timer);
    };
  }, [batch, edits, readOnly, view.id, router]);

  // ---- edits ------------------------------------------------------------------------------
  function patchRow(id: string, patch: Partial<RowEdit>) {
    setEdits((current) => current.map((edit) => (edit.id === id ? { ...edit, ...patch } : edit)));
    setRowErrors((current) => {
      if (!(id in current)) return current;
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
  }

  function problem(error: unknown): string {
    return error instanceof ApiError ? error.problem.message : "Something went wrong. Try again.";
  }

  async function addRow() {
    setBusy("row");
    try {
      const saved = await addRowRequest(view.id);
      setBase(saved.rows);
      setEdits((current) => {
        const known = new Set(current.map((edit) => edit.id));
        return [...current, ...saved.rows.filter((r) => !known.has(r.id)).map(rowToEdit)];
      });
    } catch (error) {
      setNotice({ tone: "error", text: problem(error) });
    } finally {
      setBusy(null);
    }
  }

  async function reread() {
    setAsking(null);
    setBusy("reread");
    setNotice(null);
    try {
      const { view: next, failed } = await rereadRequest(view.id);
      setBase(next.rows);
      setEdits(next.rows.map(rowToEdit));
      setBatch(next.batch);
      setRowErrors({});
      setShowErrors(false);
      setNotice(
        failed
          ? {
              tone: "warning",
              text: "The stronger model could not read it either. Your rows are unchanged.",
            }
          : {
              tone: "success",
              text: `Read again with ${MODEL_NAMES[next.model ?? ""] ?? "the stronger model"}. The rows below are the new reading.`,
            },
      );
      router.refresh();
    } catch (error) {
      setNotice({ tone: "error", text: problem(error) });
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setAsking(null);
    setBusy("cancel");
    try {
      await cancelRequest(view.id);
      router.push("/expenses");
    } catch (error) {
      setNotice({ tone: "error", text: problem(error) });
      setBusy(null);
    }
  }

  function review() {
    setShowErrors(true);
    setNotice(null);
    if (!validation.ok) {
      setRowErrors(validation.errors);
      setNotice({ tone: "error", text: validation.message });
      return;
    }
    setRowErrors({});
    dialog.current?.showModal();
  }

  async function confirm() {
    setBusy("confirm");
    try {
      await confirmRequest(view.id, { batch, rows: edits });
      dialog.current?.close();
      router.refresh();
    } catch (error) {
      dialog.current?.close();
      if (error instanceof ApiError && error.problem.rowErrors)
        setRowErrors(error.problem.rowErrors);
      setNotice({ tone: "error", text: problem(error) });
      setBusy(null);
    }
  }

  // ---- display ----------------------------------------------------------------------------
  const payers = cleaned.payerIds;
  const payerNames = payers.map(nameOf).join(" and ");
  const batchPercentMembers = Object.keys(cleaned.percents ?? {});
  const failure = view.extractionError;

  return (
    <div className="space-y-5">
      {readOnly ? (
        <Notice tone="info" role="status">
          This import belongs to{" "}
          <strong className="font-semibold">{nameOf(view.uploaderId)}</strong>. Only they can change
          it or add it to the ledger.
        </Notice>
      ) : null}

      {failure ? (
        <Notice tone="warning" role="status">
          {FAILURE_TEXT[failure]}
        </Notice>
      ) : null}
      {!failure && rows.length === 0 && !readOnly ? (
        <Notice tone="warning" role="status">
          No payments were found in this screenshot. Add them by hand, or try the stronger re-read.
        </Notice>
      ) : null}
      {view.notes.length > 0 ? (
        <Notice tone="info" role="status">
          {view.notes.join(" ")}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-muted">
        <span>
          Read by {MODEL_NAMES[view.model ?? ""] ?? view.model ?? "hand"}
          {view.rereads > 0 ? ` · re-read ${String(view.rereads)}×` : ""}
        </span>
        {view.expiresAt ? (
          <span>
            Discarded unless added by{" "}
            <LocalTime iso={view.expiresAt.toISOString()} className="font-medium text-foreground" />
          </span>
        ) : null}
      </div>

      {view.imageAvailable ? (
        <details className="rounded-2xl border border-border bg-surface">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-semibold">
            Original screenshot
          </summary>
          <div className="border-t border-border p-3">
            {/* Served by the app to signed-in members only; next/image would add nothing. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/imports/${view.id}/image`}
              alt="The uploaded screenshot"
              loading="lazy"
              className="mx-auto max-h-96 w-auto max-w-full rounded-lg object-contain"
            />
          </div>
        </details>
      ) : null}

      <section aria-labelledby="paid-by" className="space-y-3">
        <SectionTitle id="paid-by">Paid by</SectionTitle>
        <Card className="space-y-4 p-4">
          <MemberChips
            label="Paid by"
            members={members}
            selected={payers}
            disabled={readOnly}
            onToggle={(userId) => {
              setBatch((current) => toggleBatchPayer(current, userId, order));
            }}
          />
          <p className="text-sm text-muted">
            {payers.length > 1 ? `${payerNames} split each payment equally. ` : ""}
            Everyone else shares each payment equally
            {cleaned.includePayers ? ", and so do the people who paid" : ""}. Tap people on a row to
            change who shares it.
          </p>
          <div className="flex min-h-11 items-center justify-between gap-4">
            <span id="payers-share" className="text-sm font-medium">
              {payers.length > 1 ? "Payers share too" : `${payerNames} shares too`}
            </span>
            <Switch
              checked={cleaned.includePayers}
              disabled={readOnly}
              labelledBy="payers-share"
              onChange={(includePayers) => {
                setBatch((current) => ({ ...current, includePayers }));
              }}
            />
          </div>
          {readOnly ? null : (
            <ChipRadioGroup
              legend="Default split"
              name="batch-mode"
              value={cleaned.mode}
              columns="grid-cols-2"
              options={[
                { id: "equal", label: "Equal" },
                { id: "percent", label: "Percent" },
              ]}
              onChange={(mode) => {
                setBatch((current) => setBatchMode(current, mode, order));
              }}
            />
          )}
          {cleaned.mode === "percent" ? (
            <div className="space-y-2">
              <MemberChips
                label="Split by percentage between"
                members={members}
                selected={batchPercentMembers}
                disabled={readOnly}
                size="sm"
                onToggle={(userId) => {
                  setBatch((current) => toggleBatchPercentMember(current, userId, order));
                }}
              />
              <ul className="space-y-1.5">
                {order
                  .filter((id) => batchPercentMembers.includes(id))
                  .map((id) => (
                    <li key={id} className="flex items-center justify-between gap-3 text-sm">
                      <span>{nameOf(id)}</span>
                      <PercentInput
                        id={`batch-pct-${id}`}
                        label={`${nameOf(id)} default share in percent`}
                        basisPoints={cleaned.percents?.[id] ?? 0}
                        disabled={readOnly}
                        onChange={(basisPoints) => {
                          setBatch((current) => setBatchPercent(current, id, basisPoints));
                        }}
                      />
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </section>

      <section aria-labelledby="rows" className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <SectionTitle id="rows">
            {rows.length === 1 ? "1 payment" : `${String(rows.length)} payments`}
          </SectionTitle>
          {readOnly ? null : (
            <span className="pb-2 text-xs text-muted" role="status" data-testid="save-state">
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                  ? "Saved"
                  : saveState === "error"
                    ? "Could not save yet"
                    : ""}
            </span>
          )}
        </div>
        {rows.length === 0 ? null : (
          <ul className="space-y-3">
            {rows.map((row, index) => {
              const edit = edits.find((e) => e.id === row.id) ?? rowToEdit(row);
              const split = splits[index];
              if (!split) return null;
              return (
                <RowCard
                  key={row.id}
                  row={row}
                  edit={edit}
                  members={members}
                  batch={cleaned}
                  split={split}
                  errors={showErrors || rowErrors[row.id] ? rowErrors[row.id] : undefined}
                  readOnly={readOnly}
                  focusRequest={focus.id === row.id ? focus.count : 0}
                  onChange={(patch) => {
                    patchRow(row.id, patch);
                  }}
                  onToggleMember={(userId) => {
                    patchRow(row.id, { split: toggleRowMember(cleaned, row.split, userId, order) });
                  }}
                  onMode={(mode) => {
                    patchRow(row.id, { split: setRowMode(cleaned, row.split, mode, order) });
                  }}
                  onPercent={(userId, basisPoints) => {
                    patchRow(row.id, {
                      split: setRowPercent(cleaned, row.split, userId, basisPoints, order),
                    });
                  }}
                />
              );
            })}
          </ul>
        )}
        {readOnly ? null : (
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            disabled={busy !== null}
            onClick={() => {
              void addRow();
            }}
          >
            Add a payment by hand
          </Button>
        )}
      </section>

      <section aria-labelledby="totals" className="space-y-3">
        <SectionTitle id="totals">Who owes what</SectionTitle>
        <Card className="divide-y divide-border">
          {totals.map((person) => {
            const owes = Object.fromEntries(
              Object.entries(person.byCurrency).map(([currency, value]) => [
                currency,
                value.owesMinor,
              ]),
            );
            const paid = Object.fromEntries(
              Object.entries(person.byCurrency).map(([currency, value]) => [
                currency,
                value.paidMinor,
              ]),
            );
            const member = members.find((m) => m.userId === person.userId);
            return (
              <div
                key={person.userId}
                data-testid="person-total"
                className="flex min-h-14 items-center gap-3 px-4 py-2"
              >
                <Avatar name={member?.displayName ?? "?"} position={member?.position ?? 0} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{member?.displayName ?? "Someone"}</p>
                  {moneyList(paid) !== "Nothing" ? (
                    <p className="num text-sm text-muted">Paid {moneyList(paid)}</p>
                  ) : null}
                </div>
                <p className="num text-right font-semibold" data-testid="person-owes">
                  {moneyList(owes) === "Nothing" ? (
                    <span className="font-normal text-muted">Owes nothing</span>
                  ) : (
                    <>Owes {moneyList(owes)}</>
                  )}
                </p>
              </div>
            );
          })}
        </Card>
        <SumCheck
          included={includedCount}
          sums={sums}
          total={
            screenTotal
              ? { minor: screenTotal.minor, currency: screenTotal.currency, text: screenTotal.text }
              : null
          }
        />
      </section>

      {readOnly ? null : (
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="secondary"
            disabled={busy !== null || view.rereads >= 2 || !view.imageAvailable}
            onClick={() => {
              setAsking("reread");
            }}
          >
            {busy === "reread" ? "Reading…" : "Re-read with Sonnet"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              setAsking("cancel");
            }}
          >
            Cancel import
          </Button>
        </div>
      )}

      {readOnly ? null : (
        <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-10 -mx-1 sm:bottom-4">
          <div className="space-y-3 rounded-2xl border border-border bg-surface/95 p-3 shadow-lg backdrop-blur">
            {asking === "cancel" ? (
              <div
                className="flex flex-wrap items-center gap-2"
                role="alertdialog"
                aria-label="Discard this import?"
              >
                <p className="mr-auto text-sm font-medium">
                  Discard this import? Nothing is added.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAsking(null);
                  }}
                >
                  Keep editing
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    void cancel();
                  }}
                >
                  Discard import
                </Button>
              </div>
            ) : asking === "reread" ? (
              <div
                className="flex flex-wrap items-center gap-2"
                role="alertdialog"
                aria-label="Read again?"
              >
                <p className="mr-auto text-sm font-medium">
                  Read again with Sonnet? The rows below are replaced by the new reading.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAsking(null);
                  }}
                >
                  Keep my rows
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    void reread();
                  }}
                >
                  Re-read
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <p className="mr-auto min-w-0 text-sm" data-testid="summary">
                  <span className="font-semibold">
                    {includedCount} {includedCount === 1 ? "payment" : "payments"}
                  </span>{" "}
                  <span className="num text-muted">{moneyList(countedSums)}</span>
                </p>
                <Button variant="primary" disabled={busy !== null} onClick={review}>
                  Review and add
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <dialog
        ref={dialog}
        aria-labelledby="confirm-title"
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50"
      >
        <div className="max-h-[85dvh] space-y-4 overflow-y-auto p-5">
          <div>
            <h2 id="confirm-title" className="text-xl font-semibold tracking-tight">
              Confirm or make changes
            </h2>
            <p className="mt-1 text-sm text-muted">
              {includedCount} {includedCount === 1 ? "expense" : "expenses"} will be added to the
              ledger, paid by {payerNames}.
            </p>
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {going.map(({ row, counted, split }) => (
              <li key={row.id} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block font-medium break-words">{row.merchant}</span>
                    <span className="block text-muted">
                      Shared by {split.members.map(nameOf).join(", ")}
                    </span>
                  </span>
                  <span className="num shrink-0 text-right">
                    <span className="block font-semibold" data-testid="confirm-amount">
                      {moneyText(counted)}
                    </span>
                    {counted.receipt ? (
                      <span className="block text-xs text-muted">
                        {moneyText(counted.receipt)} on the receipt
                      </span>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    dialog.current?.close();
                    setFocus((current) => ({ id: row.id, count: current.count + 1 }));
                  }}
                  className="inline-flex min-h-9 items-center rounded-lg text-sm font-semibold text-accent hover:underline"
                >
                  Change the amount of {row.merchant}
                </button>
              </li>
            ))}
          </ul>
          <ul className="space-y-1 text-sm">
            {totals
              .filter((person) => Object.values(person.byCurrency).some((v) => v.owesMinor > 0))
              .map((person) => (
                <li key={person.userId} className="flex justify-between gap-3">
                  <span>{nameOf(person.userId)} owes</span>
                  <span className="num font-semibold">
                    {moneyList(
                      Object.fromEntries(
                        Object.entries(person.byCurrency).map(([c, v]) => [c, v.owesMinor]),
                      ),
                    )}
                  </span>
                </li>
              ))}
          </ul>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              disabled={busy === "confirm"}
              onClick={() => {
                dialog.current?.close();
              }}
            >
              Make changes
            </Button>
            <Button
              variant="primary"
              disabled={busy === "confirm"}
              aria-busy={busy === "confirm"}
              onClick={() => {
                void confirm();
              }}
            >
              {busy === "confirm" ? "Adding…" : "OK, add to ledger"}
            </Button>
          </div>
        </div>
      </dialog>

      <p className="text-center text-sm text-muted">
        <Link href={route("/imports")} className="underline underline-offset-2">
          All imports
        </Link>
      </p>
    </div>
  );
}

function SumCheck({
  included,
  sums,
  total,
}: {
  included: number;
  sums: Readonly<Record<string, number>>;
  total: { minor: number | null; currency: string | null; text: string } | null;
}) {
  if (included === 0) return null;
  const sumText = moneyList(sums);
  if (total === null) {
    return (
      <p className="px-1 text-sm text-muted" data-testid="sum-check">
        The ticked payments add up to{" "}
        <span className="num font-medium text-foreground">{sumText}</span>. The screenshot shows no
        total to compare with.
      </p>
    );
  }
  const comparable = total.minor !== null && total.currency !== null;
  const matches =
    comparable && sums[total.currency ?? ""] === total.minor && Object.keys(sums).length === 1;
  return (
    <p
      className={`rounded-xl border px-3 py-2 text-sm ${
        matches ? "border-positive/30 bg-positive-soft" : "border-warning/30 bg-warning-soft"
      }`}
      data-testid="sum-check"
      data-matches={matches}
    >
      {matches ? (
        <>
          Adds up to <span className="num font-semibold">{sumText}</span>, the same as the total on
          the screenshot ({total.text}).
        </>
      ) : (
        <>
          The ticked payments add up to <span className="num font-semibold">{sumText}</span>, but
          the screenshot shows a total of <span className="num font-semibold">{total.text}</span>.
          That is fine if you left some payments out on purpose.
        </>
      )}
    </p>
  );
}

/** An on/off switch: a real button with role "switch", so it works with a keyboard and a screen reader. */
function Switch({
  checked,
  disabled,
  labelledBy,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
        checked ? "bg-accent" : "bg-border-strong"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}
