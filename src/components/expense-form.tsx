"use client";

import Link from "next/link";
import { useActionState, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { saveExpenseAction, type FormState } from "@/app/actions";
import {
  CATEGORIES,
  evenBasisPoints,
  formatBasisPoints,
  formatMoney,
  formatPlainAmount,
  previewShares,
  readPositiveAmount,
  todayIn,
  validateExpenseForm,
  type ExpenseFormValues,
  type FieldErrors,
  type Member,
  type SplitMode,
} from "@/lib/ledger";
import {
  allocateSplit,
  convertMinor,
  isCurrencyCode,
  parseRate,
  REPORTING_CURRENCY,
  type CurrencyCode,
} from "@/lib/money";
import { Avatar } from "./avatar";
import {
  AmountInput,
  ChipRadioGroup,
  CurrencySelect,
  Field,
  FieldMessage,
  fieldClass,
} from "./form-controls";
import { CategoryIcon } from "./icons";
import { Button, Card, Notice } from "./ui";

const NO_ERRORS: FormState = { errors: {} };

const MODE_OPTIONS: readonly { id: SplitMode; label: string }[] = [
  { id: "equal", label: "Equal" },
  { id: "exact", label: "Exact" },
  { id: "percent", label: "Percent" },
  { id: "shares", label: "Shares" },
];

const MODE_UNIT: Record<SplitMode, string> = {
  equal: "",
  exact: "amount",
  percent: "percent",
  shares: "shares",
};

const subscribe = () => () => undefined;

export interface ExpenseFormProps {
  readonly members: readonly Member[];
  readonly initial: ExpenseFormValues;
  /** Null when adding a new expense. */
  readonly expenseId: string | null;
  /** `updatedAt` of the loaded expense; guards an edit against someone else's change. */
  readonly version: string | null;
  /** The server's idea of today, used until the browser can say what day it is where you are. */
  readonly serverToday: string;
}

export function ExpenseForm({
  members,
  initial,
  expenseId,
  version,
  serverToday,
}: ExpenseFormProps) {
  const isNew = expenseId === null;
  const order = members.map((member) => member.userId);
  const [values, setValues] = useState<ExpenseFormValues>(initial);
  const [dateTouched, setDateTouched] = useState(false);
  const [splitDirty, setSplitDirty] = useState(false);
  const [payersDirty, setPayersDirty] = useState(false);
  // Set once a submit was stopped by a mistake; from then on messages follow the form live.
  const [attempted, setAttempted] = useState(false);
  const [state, formAction, pending] = useActionState(
    saveExpenseAction.bind(null, expenseId, version),
    NO_ERRORS,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // The date field starts on the viewer's local day (the server cannot know it).
  const localToday = useSyncExternalStore(
    subscribe,
    () => todayIn(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    () => serverToday,
  );

  const converted = convertedCurrency(values);
  const effective: ExpenseFormValues = {
    ...values,
    spentOn: isNew && !dateTouched ? localToday : values.spentOn,
    // A rate only means something for a foreign currency; for SGD it is ignored.
    rate:
      values.rate && converted !== undefined && converted !== REPORTING_CURRENCY
        ? { ...values.rate, currency: converted }
        : null,
  };
  const live = validateExpenseForm(effective, order);
  const errors: FieldErrors = attempted ? (live.ok ? {} : live.errors) : state.errors;
  const currency = isCurrencyCode(values.currency) ? values.currency : undefined;
  const total = currency ? readPositiveAmount(values.amount, currency) : undefined;
  const totalMinor = total?.ok ? total.minor : undefined;

  const update = (patch: Partial<ExpenseFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  };

  // ---- payers --------------------------------------------------------------------------

  const includedPayers = values.payers.filter((payer) => payer.included);
  const multiplePayers = includedPayers.length > 1;

  const togglePayer = (userId: string, included: boolean) => {
    setPayersDirty(false);
    const next = values.payers.map((payer) =>
      payer.userId === userId ? { ...payer, included } : payer,
    );
    const ids = next.filter((payer) => payer.included).map((payer) => payer.userId);
    const evenly = ids.length > 1 && totalMinor !== undefined && currency !== undefined;
    update({
      payers: evenly
        ? next.map((payer) => ({
            ...payer,
            amount: ids.includes(payer.userId)
              ? formatPlainAmount(paidEvenly(ids, payer.userId, totalMinor, order), currency)
              : "",
          }))
        : next,
    });
  };

  const paidSum = multiplePayers
    ? includedPayers.reduce((sum, payer) => {
        const amount = currency ? readPositiveAmount(payer.amount, currency) : undefined;
        return sum + (amount?.ok ? amount.minor : 0);
      }, 0)
    : totalMinor;

  // ---- split ---------------------------------------------------------------------------

  const includedSplit = values.split.members.filter((member) => member.included);

  const evenValues = (
    mode: SplitMode,
    list: readonly { userId: string; included: boolean; value: string }[],
    amountMinor: number | undefined,
  ) => {
    const ids = list.filter((member) => member.included).map((member) => member.userId);
    return list.map((member) => {
      const position = ids.indexOf(member.userId);
      if (position < 0 || mode === "equal") return { ...member, value: "" };
      if (mode === "shares") return { ...member, value: "1" };
      if (mode === "percent") {
        return { ...member, value: formatBasisPoints(evenBasisPoints(ids.length)[position] ?? 0) };
      }
      if (amountMinor === undefined || currency === undefined) return { ...member, value: "" };
      const shares = allocateSplit(amountMinor, { kind: "equal", members: ids }, order);
      const mine = shares.find((share) => share.memberId === member.userId);
      return { ...member, value: formatPlainAmount(mine?.minor ?? 0, currency) };
    });
  };

  const setMode = (mode: SplitMode) => {
    setSplitDirty(false);
    update({ split: { mode, members: evenValues(mode, values.split.members, totalMinor) } });
  };

  const toggleSplitMember = (userId: string, included: boolean) => {
    const members = values.split.members.map((member) =>
      member.userId === userId ? { ...member, included } : member,
    );
    update({
      split: {
        mode: values.split.mode,
        members:
          splitDirty || values.split.mode === "equal"
            ? members
            : evenValues(values.split.mode, members, totalMinor),
      },
    });
  };

  const setSplitValue = (userId: string, value: string) => {
    setSplitDirty(true);
    update({
      split: {
        mode: values.split.mode,
        members: values.split.members.map((member) =>
          member.userId === userId ? { ...member, value } : member,
        ),
      },
    });
  };

  const changeAmount = (amount: string) => {
    const next = currency ? readPositiveAmount(amount, currency) : undefined;
    const nextTotal = next?.ok ? next.minor : undefined;
    const refillSplit = values.split.mode === "exact" && !splitDirty;
    const refillPayers = multiplePayers && !payersDirty && nextTotal !== undefined && currency;
    const payerIds = includedPayers.map((payer) => payer.userId);
    update({
      amount,
      split: refillSplit
        ? { mode: "exact", members: evenValues("exact", values.split.members, nextTotal) }
        : values.split,
      payers: refillPayers
        ? values.payers.map((payer) =>
            payer.included
              ? {
                  ...payer,
                  amount: formatPlainAmount(
                    paidEvenly(payerIds, payer.userId, nextTotal, order),
                    currency,
                  ),
                }
              : payer,
          )
        : values.payers,
    });
  };

  const sharesPreview =
    totalMinor !== undefined && currency !== undefined
      ? previewShares(values.split, totalMinor, currency, order)
      : undefined;
  const shareOf = (userId: string) =>
    sharesPreview?.find((share) => share.userId === userId)?.amountMinor;

  const splitStatus = describeSplit(values, includedSplit.length, totalMinor, currency);

  // ---- submit --------------------------------------------------------------------------

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    const result = validateExpenseForm(effective, order);
    if (result.ok) {
      setAttempted(false);
      return;
    }
    event.preventDefault();
    setAttempted(true);
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };

  const errorCount = Object.keys(errors).length;

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} noValidate className="space-y-5">
      <input type="hidden" name="payload" value={JSON.stringify(effective)} />

      {errorCount > 0 ? (
        <Notice tone="error" role="alert">
          {errors.form ??
            `Fix the ${errorCount === 1 ? "problem" : `${String(errorCount)} problems`} marked below.`}
        </Notice>
      ) : null}

      <Card className="space-y-4 p-4">
        <Field label="Description" htmlFor="description" error={errors.description}>
          <input
            id="description"
            type="text"
            autoComplete="off"
            maxLength={120}
            value={values.description}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby="description-message"
            placeholder="Dinner at Trattoria Roma"
            onChange={(event) => {
              update({ description: event.target.value });
            }}
            className={fieldClass(Boolean(errors.description))}
          />
        </Field>

        <ChipRadioGroup
          legend="Category"
          name="category"
          value={values.category}
          options={CATEGORIES.map((category) => ({
            id: category.id,
            label: category.label,
            icon: <CategoryIcon category={category.id} width={18} height={18} />,
          }))}
          onChange={(category) => {
            update({ category });
          }}
        />
      </Card>

      <Card className="space-y-4 p-4">
        <div className="grid grid-cols-[1fr_6.5rem] gap-3">
          <Field label="Amount" htmlFor="amount" error={errors.amount}>
            <AmountInput
              id="amount"
              value={values.amount}
              placeholder="0.00"
              invalid={Boolean(errors.amount)}
              aria-describedby="amount-message"
              onChange={(event) => {
                changeAmount(event.target.value);
              }}
            />
          </Field>
          <Field label="Currency" htmlFor="currency" error={errors.currency}>
            <CurrencySelect
              id="currency"
              value={values.currency}
              invalid={Boolean(errors.currency)}
              onChange={(event) => {
                update({ currency: event.target.value });
              }}
            />
          </Field>
        </div>

        <Field label="Date" htmlFor="spentOn" error={errors.spentOn}>
          <input
            id="spentOn"
            type="date"
            value={effective.spentOn}
            aria-invalid={errors.spentOn ? true : undefined}
            aria-describedby="spentOn-message"
            onChange={(event) => {
              setDateTouched(true);
              update({ spentOn: event.target.value });
            }}
            className={fieldClass(Boolean(errors.spentOn))}
          />
        </Field>

        <SgdLine values={effective} totalMinor={totalMinor} />

        <ForeignSections values={values} errors={errors} converted={converted} onChange={update} />
      </Card>

      <Card className="p-4">
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Paid by</legend>
          <p className="mb-3 text-sm text-muted">
            {multiplePayers
              ? "Enter what each person paid. It has to add up to the amount."
              : "Tick more than one person if the bill was paid together."}
          </p>
          <ul className="divide-y divide-border">
            {members.map((member) => {
              const row = values.payers.find((payer) => payer.userId === member.userId);
              const included = row?.included ?? false;
              const rowError = errors[`payers.${member.userId}`];
              return (
                <li key={member.userId} className="flex min-h-14 items-center gap-3 py-2">
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={(event) => {
                        togglePayer(member.userId, event.target.checked);
                      }}
                      className="size-5 shrink-0 accent-[var(--accent)]"
                    />
                    <Avatar name={member.displayName} position={member.position} size="sm" />
                    <span className="truncate font-medium">{member.displayName}</span>
                  </label>
                  {multiplePayers && included ? (
                    <div className="w-32 shrink-0">
                      <AmountInput
                        aria-label={`${member.displayName} paid`}
                        value={row?.amount ?? ""}
                        placeholder="0.00"
                        invalid={Boolean(rowError)}
                        onChange={(event) => {
                          setPayersDirty(true);
                          update({
                            payers: values.payers.map((payer) =>
                              payer.userId === member.userId
                                ? { ...payer, amount: event.target.value }
                                : payer,
                            ),
                          });
                        }}
                      />
                      {rowError ? (
                        <p role="alert" className="mt-1 text-xs text-negative">
                          {rowError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <TotalLine
            id="payers-message"
            error={errors.payers}
            ok={
              multiplePayers &&
              currency !== undefined &&
              paidSum !== undefined &&
              paidSum === totalMinor
                ? `Adds up to ${formatMoney(paidSum, currency)}`
                : undefined
            }
            warn={
              multiplePayers &&
              currency !== undefined &&
              totalMinor !== undefined &&
              paidSum !== totalMinor
                ? remainingText(totalMinor, paidSum ?? 0, currency, "to assign")
                : undefined
            }
          />
        </fieldset>
      </Card>

      <Card className="p-4">
        <fieldset>
          <legend className="mb-3 text-sm font-medium">Split between</legend>
          <ChipRadioGroup
            legend="How to split"
            name="split-mode"
            value={values.split.mode}
            options={MODE_OPTIONS}
            columns="grid-cols-4"
            hideLegend
            onChange={setMode}
          />
          <ul className="mt-3 divide-y divide-border">
            {members.map((member) => {
              const row = values.split.members.find((entry) => entry.userId === member.userId);
              const included = row?.included ?? false;
              const rowError = errors[`split.${member.userId}`];
              const share = included ? shareOf(member.userId) : undefined;
              const showShare =
                share !== undefined && currency !== undefined && values.split.mode !== "exact";
              return (
                <li key={member.userId} className="flex min-h-14 items-center gap-3 py-2">
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={included}
                      aria-label={`${member.displayName} shares this`}
                      onChange={(event) => {
                        toggleSplitMember(member.userId, event.target.checked);
                      }}
                      className="size-5 shrink-0 accent-[var(--accent)]"
                    />
                    <Avatar name={member.displayName} position={member.position} size="sm" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{member.displayName}</span>
                      {showShare ? (
                        <span
                          className="num block text-sm text-muted"
                          data-testid={`share-${member.displayName}`}
                        >
                          {formatMoney(share, currency)}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {values.split.mode !== "equal" && included ? (
                    <div className="w-32 shrink-0">
                      <div className="relative">
                        <AmountInput
                          aria-label={`${member.displayName} ${MODE_UNIT[values.split.mode]}`}
                          value={row?.value ?? ""}
                          invalid={Boolean(rowError)}
                          inputMode={values.split.mode === "shares" ? "numeric" : "decimal"}
                          className={values.split.mode === "percent" ? "pr-8" : ""}
                          onChange={(event) => {
                            setSplitValue(member.userId, event.target.value);
                          }}
                        />
                        {values.split.mode === "percent" ? (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted"
                          >
                            %
                          </span>
                        ) : null}
                      </div>
                      {rowError ? (
                        <p role="alert" className="mt-1 text-xs text-negative">
                          {rowError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <TotalLine
              id="split-message"
              error={errors.split}
              ok={splitStatus.ok}
              warn={splitStatus.warn}
            />
            {values.split.mode === "exact" || values.split.mode === "percent" ? (
              <Button
                variant="ghost"
                className="min-h-9 px-3"
                onClick={() => {
                  setSplitDirty(false);
                  update({
                    split: {
                      mode: values.split.mode,
                      members: evenValues(values.split.mode, values.split.members, totalMinor),
                    },
                  });
                }}
              >
                Split evenly
              </Button>
            ) : null}
          </div>
        </fieldset>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link
          href={isNew ? "/expenses" : `/expenses/${expenseId}`}
          className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold text-muted hover:text-foreground"
        >
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={pending} className="sm:min-w-40">
          {pending ? "Saving..." : isNew ? "Add expense" : "Save changes"}
        </Button>
      </div>
      <p className="sr-only" aria-live="polite">
        {pending ? "Saving" : ""}
      </p>
    </form>
  );
}

/** The currency that gets converted to SGD: what the bank billed, otherwise what the receipt shows. */
function convertedCurrency(values: ExpenseFormValues): CurrencyCode | undefined {
  if (
    values.billed &&
    isCurrencyCode(values.billed.currency) &&
    values.billed.amount.trim() !== ""
  ) {
    return values.billed.currency;
  }
  return isCurrencyCode(values.currency) ? values.currency : undefined;
}

/** Splits `total` among the payers so the first lines add up exactly (spare cents by member order). */
function paidEvenly(
  ids: readonly string[],
  userId: string,
  total: number,
  order: readonly string[],
): number {
  const shares = allocateSplit(total, { kind: "equal", members: ids }, order);
  return shares.find((share) => share.memberId === userId)?.minor ?? 0;
}

function remainingText(total: number, entered: number, currency: CurrencyCode, suffix: string) {
  const difference = total - entered;
  return difference > 0
    ? `${formatMoney(difference, currency)} left ${suffix}`
    : `${formatMoney(-difference, currency)} over`;
}

function describeSplit(
  values: ExpenseFormValues,
  includedCount: number,
  totalMinor: number | undefined,
  currency: CurrencyCode | undefined,
): { ok?: string; warn?: string } {
  if (includedCount === 0) return { warn: "Pick at least one person" };
  const { mode, members } = values.split;
  if (mode === "equal" || mode === "shares") {
    return currency !== undefined && totalMinor !== undefined
      ? { ok: `${formatMoney(totalMinor, currency)} shared between ${String(includedCount)}` }
      : {};
  }
  const included = members.filter((member) => member.included);
  if (mode === "percent") {
    const entered = included.reduce((sum, member) => {
      const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(member.value.trim());
      return match ? sum + Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : sum;
    }, 0);
    return entered === 10_000
      ? { ok: "Adds up to 100%" }
      : { warn: `${formatBasisPoints(entered)}% of 100% entered` };
  }
  if (currency === undefined || totalMinor === undefined) return {};
  const entered = included.reduce((sum, member) => {
    const amount = readPositiveAmount(member.value, currency);
    return sum + (amount.ok ? amount.minor : 0);
  }, 0);
  return entered === totalMinor
    ? { ok: `Adds up to ${formatMoney(totalMinor, currency)}` }
    : { warn: remainingText(totalMinor, entered, currency, "to assign") };
}

function TotalLine({
  id,
  error,
  ok,
  warn,
}: {
  id: string;
  error?: string | undefined;
  ok?: string | undefined;
  warn?: string | undefined;
}) {
  if (error) return <FieldMessage id={id} error={error} />;
  if (warn) {
    return (
      <p id={id} className="num mt-2 text-sm font-medium text-warning">
        {warn}
      </p>
    );
  }
  return ok ? (
    <p id={id} className="num mt-2 text-sm text-muted">
      {ok}
    </p>
  ) : null;
}

/** Explains how the amount will count in SGD, so nothing about the conversion is a surprise. */
function SgdLine({
  values,
  totalMinor,
}: {
  values: ExpenseFormValues;
  totalMinor: number | undefined;
}) {
  const currency = isCurrencyCode(values.currency) ? values.currency : undefined;
  if (!currency || currency === REPORTING_CURRENCY) return null;

  const billed = values.billed;
  const billedAmount =
    billed && isCurrencyCode(billed.currency)
      ? readPositiveAmount(billed.amount, billed.currency)
      : undefined;
  let text = "Counted in SGD at that day's market rate, fetched when you save.";

  if (billed && billedAmount?.ok && isCurrencyCode(billed.currency)) {
    const billedCurrency = billed.currency;
    if (billedCurrency === REPORTING_CURRENCY) {
      text = `Counts as ${formatMoney(billedAmount.minor, REPORTING_CURRENCY)}, exactly what the bank billed.`;
    } else {
      text = `Converted from the billed ${formatMoney(billedAmount.minor, billedCurrency)} at that day's rate.`;
    }
  }
  const converted = convertedCurrency(values);
  const rate = values.rate?.rate.trim();
  if (
    rate &&
    converted &&
    converted !== REPORTING_CURRENCY &&
    !(billedAmount?.ok && billed?.currency === REPORTING_CURRENCY)
  ) {
    const base = billedAmount?.ok ? billedAmount.minor : totalMinor;
    try {
      const parsed = parseRate(rate.replace(/^(\d+),(\d+)$/, "$1.$2"));
      if (base !== undefined) {
        text = `Counts as about ${formatMoney(convertMinor(base, converted, REPORTING_CURRENCY, parsed), REPORTING_CURRENCY)} at your rate.`;
      }
    } catch {
      // A half-typed rate: the field reports the problem on submit.
    }
  }
  return <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-muted">{text}</p>;
}

/** The optional "billed by my bank" and "use my own rate" sections. */
function ForeignSections({
  values,
  errors,
  converted,
  onChange,
}: {
  values: ExpenseFormValues;
  errors: FieldErrors;
  converted: CurrencyCode | undefined;
  onChange: (patch: Partial<ExpenseFormValues>) => void;
}) {
  const billed = values.billed;
  const rate = values.rate;
  const needsRate = converted !== undefined && converted !== REPORTING_CURRENCY;
  const rateOpen = rate !== null;

  return (
    <div className="space-y-3">
      {billed ? (
        <div className="space-y-3 rounded-xl border border-border bg-surface-muted/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Billed by my bank</p>
            <Button
              variant="ghost"
              className="min-h-9 px-3"
              onClick={() => {
                onChange({ billed: null });
              }}
            >
              Remove
            </Button>
          </div>
          <div className="grid grid-cols-[1fr_6.5rem] gap-3">
            <Field label="Billed amount" htmlFor="billed-amount" error={errors["billed.amount"]}>
              <AmountInput
                id="billed-amount"
                value={billed.amount}
                placeholder="0.00"
                invalid={Boolean(errors["billed.amount"])}
                aria-describedby="billed-amount-message"
                onChange={(event) => {
                  onChange({ billed: { ...billed, amount: event.target.value } });
                }}
              />
            </Field>
            <Field label="Billed in" htmlFor="billed-currency" error={errors["billed.currency"]}>
              <CurrencySelect
                id="billed-currency"
                value={billed.currency}
                invalid={Boolean(errors["billed.currency"])}
                onChange={(event) => {
                  onChange({ billed: { ...billed, currency: event.target.value } });
                }}
              />
            </Field>
          </div>
          <p className="text-sm text-muted">
            What your card statement says. If it is in SGD that exact figure is used; otherwise the
            billed amount is converted instead of the shown one.
          </p>
        </div>
      ) : null}

      {rateOpen && needsRate ? (
        <div className="space-y-3 rounded-xl border border-border bg-surface-muted/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">My own exchange rate</p>
            <Button
              variant="ghost"
              className="min-h-9 px-3"
              onClick={() => {
                onChange({ rate: null });
              }}
            >
              Remove
            </Button>
          </div>
          <Field
            label={`SGD per 1 ${converted}`}
            htmlFor="rate"
            error={errors["rate.rate"] ?? errors["rate.currency"]}
            hint={`Used for this expense only, instead of the day's market rate. 1 ${converted} = S$ ...`}
          >
            <AmountInput
              id="rate"
              value={rate.rate}
              placeholder="1.5340"
              invalid={Boolean(errors["rate.rate"] ?? errors["rate.currency"])}
              aria-describedby="rate-message"
              onChange={(event) => {
                onChange({ rate: { rate: event.target.value, currency: converted } });
              }}
            />
          </Field>
        </div>
      ) : null}

      {!billed || (!rateOpen && needsRate) ? (
        <div className="flex flex-wrap gap-2">
          {!billed ? (
            <Button
              variant="secondary"
              className="min-h-9 px-3 font-medium"
              onClick={() => {
                onChange({ billed: { amount: "", currency: REPORTING_CURRENCY } });
              }}
            >
              + Billed amount
            </Button>
          ) : null}
          {!rateOpen && needsRate ? (
            <Button
              variant="secondary"
              className="min-h-9 px-3 font-medium"
              onClick={() => {
                onChange({ rate: { rate: "", currency: converted } });
              }}
            >
              + My own rate
            </Button>
          ) : null}
        </div>
      ) : null}
      {errors["rate.rate"] && !rateOpen ? (
        <p role="alert" className="text-sm text-negative">
          {errors["rate.rate"]}
        </p>
      ) : null}
    </div>
  );
}
