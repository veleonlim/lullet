"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, categoryLabel, formatDate, type FieldErrors, type Member } from "@/lib/ledger";
import {
  countedAmount,
  isBlocking,
  ISSUE_TEXT,
  moneyText,
  rowState,
  type BatchSplit,
  type DraftRow,
  type FieldState,
  type RowEdit,
  type SplitResult,
} from "@/lib/import";
import { route } from "@/lib/routes";
import {
  AmountInput,
  ChipRadioGroup,
  Field,
  fieldClass,
  orderedCurrencies,
} from "../form-controls";
import { CategoryIcon } from "../icons";
import { Pill } from "../ui";
import { MemberChips, PercentInput } from "./member-chips";

/** Uncertain or guessed values get a dotted underline, like the design's "check" mark. */
function doubt(state: FieldState | undefined): string {
  return state === "uncertain" || state === "guessed"
    ? "underline decoration-warning decoration-dotted decoration-2 underline-offset-4"
    : "";
}

export function RowChips({ row }: { row: DraftRow }) {
  const state = rowState(row.fieldStates);
  const reasons = row.issues
    .filter((issue) => !issue.startsWith("note:") && issue !== "possible_duplicate")
    .map((issue) => ISSUE_TEXT[issue] ?? issue);
  return (
    <>
      {state === "unreadable" ? (
        <span title={reasons.join(". ")}>
          <Pill tone="negative">Needs input</Pill>
        </span>
      ) : state === "uncertain" || state === "guessed" ? (
        <span title={reasons.join(". ") || "Please check this row"}>
          <Pill tone="warning">Check</Pill>
        </span>
      ) : null}
      {row.duplicateOf ? <Pill tone="warning">Possible duplicate</Pill> : null}
    </>
  );
}

export function RowCard({
  row,
  edit,
  members,
  batch,
  split,
  errors,
  readOnly,
  focusRequest,
  onChange,
  onToggleMember,
  onMode,
  onPercent,
}: {
  row: DraftRow;
  edit: RowEdit;
  members: readonly Member[];
  batch: BatchSplit;
  split: SplitResult;
  errors: FieldErrors | undefined;
  readOnly: boolean;
  /** Bumped by the parent to open this row's edit panel and bring it into view. */
  focusRequest: number;
  onChange: (patch: Partial<RowEdit>) => void;
  onToggleMember: (userId: string) => void;
  onMode: (mode: "equal" | "percent") => void;
  onPercent: (userId: string, basisPoints: number) => void;
}) {
  const needsInput = isBlocking(row.fieldStates);
  const [open, setOpen] = useState(needsInput || focusRequest > 0);
  const card = useRef<HTMLLIElement>(null);
  const name = row.merchant ?? "this row";
  const id = `row-${row.id}`;
  const counted = countedAmount(row);
  const amountShown = counted ? moneyText(counted) : null;
  const receiptShown = counted?.receipt ? moneyText(counted.receipt) : null;

  // The review screen asks for this row to be opened (from the confirm step, or a link from the chat).
  const [seenRequest, setSeenRequest] = useState(focusRequest);
  if (seenRequest !== focusRequest) {
    setSeenRequest(focusRequest);
    if (focusRequest > 0) setOpen(true);
  }
  useEffect(() => {
    if (focusRequest === 0) return;
    const frame = requestAnimationFrame(() => {
      card.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      card.current?.querySelector<HTMLInputElement>(`#${CSS.escape(`${id}-amount`)}`)?.focus({
        preventScroll: true,
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focusRequest, id]);
  const notes = row.issues.filter((issue) => issue.startsWith("note:")).map((i) => i.slice(5));
  const reasons = row.issues
    .filter((issue) => !issue.startsWith("note:") && issue !== "possible_duplicate")
    .map((issue) => ISSUE_TEXT[issue] ?? issue);
  const selected = split.ok ? split.split.members : [];
  const mode = split.ok ? split.split.mode : (row.split?.mode ?? batch.mode);
  const rowErrors = errors ? Object.entries(errors) : [];

  return (
    <li
      ref={card}
      id={id}
      data-testid="import-row"
      data-included={row.included}
      className={`rounded-2xl border bg-surface ${
        errors ? "border-negative" : "border-border"
      } ${row.included ? "" : "opacity-75"}`}
    >
      <div className="flex items-start gap-1 p-3 pb-2">
        <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={edit.included}
            disabled={readOnly}
            onChange={(event) => {
              onChange({ included: event.target.checked });
            }}
            aria-label={`Include ${name}`}
            className="size-5 accent-[var(--accent)]"
          />
        </label>
        <div className="min-w-0 flex-1 pt-1.5">
          <div className="flex items-start justify-between gap-3">
            <p
              className={`min-w-0 font-medium break-words ${row.merchant === null ? "text-negative" : ""} ${doubt(row.fieldStates.merchant)}`}
              data-testid="row-merchant"
            >
              {row.merchant ?? "Needs a description"}
            </p>
            <p className="shrink-0 text-right">
              <span
                className={`num block font-semibold ${amountShown === null ? "text-negative" : ""} ${doubt(row.fieldStates.amount)} ${doubt(row.fieldStates.currency)}`}
                data-testid="row-amount"
              >
                {amountShown ?? "Needs amount"}
              </span>
              {receiptShown ? (
                <span className="num block text-xs text-muted" data-testid="row-receipt-amount">
                  {receiptShown} on the receipt
                </span>
              ) : null}
            </p>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1">
              <CategoryIcon category={row.category} width={16} height={16} />
              <span className={doubt(row.fieldStates.category)}>{categoryLabel(row.category)}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className={row.spentOn === null ? "text-negative" : doubt(row.fieldStates.date)}>
              {row.spentOn ? formatDate(row.spentOn) : "Needs a date"}
            </span>
            <RowChips row={row} />
          </p>
          {row.duplicateOf ? (
            <p className="mt-1.5 text-sm text-muted">
              Looks like{" "}
              <Link
                href={route(
                  row.duplicateOf.kind === "expense"
                    ? `/expenses/${row.duplicateOf.id}`
                    : `/imports/${row.duplicateOf.importId ?? ""}`,
                )}
                className="font-medium text-accent underline underline-offset-2"
              >
                {row.duplicateOf.label}
              </Link>{" "}
              {row.duplicateOf.kind === "expense" ? "in the ledger" : "in another draft"}. Left
              unticked.
            </p>
          ) : null}
          {reasons.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 text-sm text-muted">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {notes.length > 0 ? (
            <p className="mt-1 text-sm text-muted italic">{notes.join(" · ")}</p>
          ) : null}
          {readOnly ? null : (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-edit`}
              onClick={() => {
                setOpen((value) => !value);
              }}
              className="mt-2 inline-flex min-h-10 items-center rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold text-accent hover:bg-surface-muted"
            >
              {open ? "Close details" : `Edit ${row.merchant ?? "row"}`}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            id={`${id}-shared`}
            className="text-xs font-semibold tracking-wide text-muted uppercase"
          >
            Shared by
          </p>
          {mode === "percent" ? <Pill>By percentage</Pill> : null}
        </div>
        <MemberChips
          label={`Who shares ${name}`}
          members={members}
          selected={selected}
          disabled={readOnly}
          size="sm"
          onToggle={onToggleMember}
        />
        {mode === "percent" && split.ok ? (
          <ul className="space-y-1.5">
            {split.split.members.map((userId) => {
              const person = members.find((m) => m.userId === userId);
              return (
                <li key={userId} className="flex items-center justify-between gap-3 text-sm">
                  <span>{person?.displayName ?? "Someone"}</span>
                  <PercentInput
                    id={`${id}-pct-${userId}`}
                    label={`${person?.displayName ?? "Someone"} share of ${name} in percent`}
                    basisPoints={split.split.basisPoints?.[userId] ?? 0}
                    disabled={readOnly}
                    onChange={(basisPoints) => {
                      onPercent(userId, basisPoints);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
        {!split.ok ? (
          <p role="alert" className="text-sm text-negative">
            {split.message}
          </p>
        ) : null}
        {rowErrors.length > 0 ? (
          <ul role="alert" className="space-y-0.5 text-sm text-negative">
            {rowErrors.map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {open && !readOnly ? (
        <div id={`${id}-edit`} className="space-y-4 border-t border-border bg-surface-muted/50 p-4">
          <Field label="Description" htmlFor={`${id}-merchant`} error={errors?.merchant}>
            <input
              id={`${id}-merchant`}
              value={edit.merchant}
              maxLength={120}
              onChange={(event) => {
                onChange({ merchant: event.target.value });
              }}
              className={fieldClass(
                Boolean(errors?.merchant) || row.fieldStates.merchant === "unreadable",
              )}
            />
          </Field>
          <Field label="Date" htmlFor={`${id}-date`} error={errors?.date}>
            <input
              id={`${id}-date`}
              type="date"
              value={edit.date}
              onChange={(event) => {
                onChange({ date: event.target.value });
              }}
              className={fieldClass(Boolean(errors?.date) || row.fieldStates.date === "unreadable")}
            />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <Field label="Amount" htmlFor={`${id}-amount`} error={errors?.amount}>
              <AmountInput
                id={`${id}-amount`}
                value={edit.amount}
                invalid={Boolean(errors?.amount) || row.fieldStates.amount === "unreadable"}
                placeholder="48.50"
                onChange={(event) => {
                  onChange({ amount: event.target.value });
                }}
              />
            </Field>
            <Field label="Currency" htmlFor={`${id}-currency`} error={errors?.currency}>
              <select
                id={`${id}-currency`}
                value={edit.currency}
                onChange={(event) => {
                  onChange({ currency: event.target.value });
                }}
                className={fieldClass(
                  Boolean(errors?.currency) || row.fieldStates.currency === "unreadable",
                )}
              >
                <option value="">Pick…</option>
                {orderedCurrencies().map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="space-y-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
              <Field label="Charged to your card (optional)" htmlFor={`${id}-billed`}>
                <AmountInput
                  id={`${id}-billed`}
                  value={edit.billedAmount}
                  placeholder="144.26"
                  onChange={(event) => {
                    onChange({ billedAmount: event.target.value });
                  }}
                />
              </Field>
              <Field label="Charged in" htmlFor={`${id}-billed-currency`}>
                <select
                  id={`${id}-billed-currency`}
                  value={edit.billedCurrency}
                  onChange={(event) => {
                    onChange({ billedCurrency: event.target.value });
                  }}
                  className={fieldClass(false)}
                >
                  <option value="">None</option>
                  {orderedCurrencies().map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="text-xs text-muted">
              When your bank charged a different amount, for example S$144.26 for a €100.00 payment,
              that is the amount that counts.
            </p>
          </div>
          <ChipRadioGroup
            legend="Category"
            name={`${id}-category`}
            value={edit.category as (typeof CATEGORIES)[number]["id"]}
            columns="grid-cols-3"
            options={CATEGORIES.map((category) => ({
              id: category.id,
              label: category.label,
              icon: <CategoryIcon category={category.id} width={16} height={16} />,
            }))}
            onChange={(category) => {
              onChange({ category });
            }}
          />
          <ChipRadioGroup
            legend="Split"
            name={`${id}-mode`}
            value={mode}
            columns="grid-cols-2"
            options={[
              { id: "equal", label: "Equal" },
              { id: "percent", label: "Percent" },
            ]}
            onChange={onMode}
          />
        </div>
      ) : null}
    </li>
  );
}
