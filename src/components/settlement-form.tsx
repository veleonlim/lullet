"use client";

import Link from "next/link";
import { useActionState, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { saveSettlementAction, type FormState } from "@/app/actions";
import {
  formatMoney,
  readPositiveAmount,
  todayIn,
  validateSettlementForm,
  type FieldErrors,
  type Member,
  type SettlementFormValues,
} from "@/lib/ledger";
import { isCurrencyCode, REPORTING_CURRENCY, type CurrencyCode } from "@/lib/money";
import { Avatar } from "./avatar";
import { AmountInput, CurrencySelect, Field, fieldClass } from "./form-controls";
import { ArrowRightIcon } from "./icons";
import { Button, Card, Notice } from "./ui";

const NO_ERRORS: FormState = { errors: {} };
const subscribe = () => () => undefined;

export function SettlementForm({
  members,
  initial,
  serverToday,
  freshDate,
}: {
  members: readonly Member[];
  initial: SettlementFormValues;
  serverToday: string;
  /** True when the date should follow the viewer's local day (no date was chosen yet). */
  freshDate: boolean;
}) {
  const order = members.map((member) => member.userId);
  const [values, setValues] = useState(initial);
  const [dateTouched, setDateTouched] = useState(false);
  // Set once a submit was stopped by a mistake; from then on messages follow the form live.
  const [attempted, setAttempted] = useState(false);
  const [state, formAction, pending] = useActionState(saveSettlementAction, NO_ERRORS);
  const formRef = useRef<HTMLFormElement>(null);

  const localToday = useSyncExternalStore(
    subscribe,
    () => todayIn(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    () => serverToday,
  );

  const converted: CurrencyCode | undefined =
    values.billed && isCurrencyCode(values.billed.currency) && values.billed.amount.trim() !== ""
      ? values.billed.currency
      : isCurrencyCode(values.currency)
        ? values.currency
        : undefined;
  const needsRate = converted !== undefined && converted !== REPORTING_CURRENCY;

  const effective: SettlementFormValues = {
    ...values,
    settledOn: freshDate && !dateTouched ? localToday : values.settledOn,
    rate: values.rate && needsRate ? { ...values.rate, currency: converted } : null,
  };
  const live = validateSettlementForm(effective, order);
  const errors: FieldErrors = attempted ? (live.ok ? {} : live.errors) : state.errors;
  const update = (patch: Partial<SettlementFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    const result = validateSettlementForm(effective, order);
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

  const from = members.find((member) => member.userId === values.fromUserId);
  const to = members.find((member) => member.userId === values.toUserId);
  const currency = isCurrencyCode(values.currency) ? values.currency : undefined;
  const amount = currency ? readPositiveAmount(values.amount, currency) : undefined;
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
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="Paid by" htmlFor="fromUserId" error={errors.fromUserId}>
            <MemberSelect
              id="fromUserId"
              members={members}
              value={values.fromUserId}
              invalid={Boolean(errors.fromUserId)}
              onChange={(fromUserId) => {
                update({ fromUserId });
              }}
            />
          </Field>
          <ArrowRightIcon width={20} height={20} className="mb-3 text-muted" />
          <Field label="Paid to" htmlFor="toUserId" error={errors.toUserId}>
            <MemberSelect
              id="toUserId"
              members={members}
              value={values.toUserId}
              invalid={Boolean(errors.toUserId)}
              onChange={(toUserId) => {
                update({ toUserId });
              }}
            />
          </Field>
        </div>

        <div className="grid grid-cols-[1fr_6.5rem] gap-3">
          <Field label="Amount" htmlFor="amount" error={errors.amount}>
            <AmountInput
              id="amount"
              value={values.amount}
              placeholder="0.00"
              invalid={Boolean(errors.amount)}
              aria-describedby="amount-message"
              onChange={(event) => {
                update({ amount: event.target.value });
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

        <Field label="Date" htmlFor="settledOn" error={errors.settledOn}>
          <input
            id="settledOn"
            type="date"
            value={effective.settledOn}
            aria-invalid={errors.settledOn ? true : undefined}
            aria-describedby="settledOn-message"
            onChange={(event) => {
              setDateTouched(true);
              update({ settledOn: event.target.value });
            }}
            className={fieldClass(Boolean(errors.settledOn))}
          />
        </Field>

        <Field label="Note (optional)" htmlFor="note" error={errors.note}>
          <input
            id="note"
            type="text"
            autoComplete="off"
            value={values.note}
            placeholder="Cash at the hotel"
            aria-invalid={errors.note ? true : undefined}
            aria-describedby="note-message"
            onChange={(event) => {
              update({ note: event.target.value });
            }}
            className={fieldClass(Boolean(errors.note))}
          />
        </Field>

        {currency !== undefined && currency !== REPORTING_CURRENCY ? (
          <div className="space-y-3">
            {values.billed ? (
              <div className="space-y-3 rounded-xl border border-border bg-surface-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Billed by my bank</p>
                  <Button
                    variant="ghost"
                    className="min-h-9 px-3"
                    onClick={() => {
                      update({ billed: null });
                    }}
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid grid-cols-[1fr_6.5rem] gap-3">
                  <Field
                    label="Billed amount"
                    htmlFor="billed-amount"
                    error={errors["billed.amount"]}
                  >
                    <AmountInput
                      id="billed-amount"
                      value={values.billed.amount}
                      placeholder="0.00"
                      invalid={Boolean(errors["billed.amount"])}
                      onChange={(event) => {
                        update({
                          billed: {
                            ...(values.billed ?? { currency: "SGD" }),
                            amount: event.target.value,
                          },
                        });
                      }}
                    />
                  </Field>
                  <Field
                    label="Billed in"
                    htmlFor="billed-currency"
                    error={errors["billed.currency"]}
                  >
                    <CurrencySelect
                      id="billed-currency"
                      value={values.billed.currency}
                      invalid={Boolean(errors["billed.currency"])}
                      onChange={(event) => {
                        update({
                          billed: {
                            ...(values.billed ?? { amount: "" }),
                            currency: event.target.value,
                          },
                        });
                      }}
                    />
                  </Field>
                </div>
              </div>
            ) : null}
            {values.rate && needsRate ? (
              <div className="space-y-3 rounded-xl border border-border bg-surface-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">My own exchange rate</p>
                  <Button
                    variant="ghost"
                    className="min-h-9 px-3"
                    onClick={() => {
                      update({ rate: null });
                    }}
                  >
                    Remove
                  </Button>
                </div>
                <Field
                  label={`SGD per 1 ${converted}`}
                  htmlFor="rate"
                  error={errors["rate.rate"] ?? errors["rate.currency"]}
                >
                  <AmountInput
                    id="rate"
                    value={values.rate.rate}
                    placeholder="1.5340"
                    invalid={Boolean(errors["rate.rate"] ?? errors["rate.currency"])}
                    onChange={(event) => {
                      update({ rate: { rate: event.target.value, currency: converted } });
                    }}
                  />
                </Field>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {!values.billed ? (
                <Button
                  variant="secondary"
                  className="min-h-9 px-3 font-medium"
                  onClick={() => {
                    update({ billed: { amount: "", currency: REPORTING_CURRENCY } });
                  }}
                >
                  + Billed amount
                </Button>
              ) : null}
              {!values.rate && needsRate ? (
                <Button
                  variant="secondary"
                  className="min-h-9 px-3 font-medium"
                  onClick={() => {
                    update({ rate: { rate: "", currency: converted } });
                  }}
                >
                  + My own rate
                </Button>
              ) : null}
            </div>
            {errors["rate.rate"] && !values.rate ? (
              <p role="alert" className="text-sm text-negative">
                {errors["rate.rate"]}
              </p>
            ) : null}
            <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-muted">
              Counted in SGD at that day&apos;s market rate unless you give a billed SGD amount or
              your own rate.
            </p>
          </div>
        ) : null}
      </Card>

      {from && to && amount?.ok && currency ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted" aria-live="polite">
          <Avatar name={from.displayName} position={from.position} size="sm" />
          <span>
            <strong className="font-semibold text-foreground">{from.displayName}</strong> pays{" "}
            <strong className="font-semibold text-foreground">{to.displayName}</strong>{" "}
            <span className="num">{formatMoney(amount.minor, currency)}</span>
          </span>
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link
          href="/balances"
          className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold text-muted hover:text-foreground"
        >
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={pending} className="sm:min-w-44">
          {pending ? "Saving..." : "Record settlement"}
        </Button>
      </div>
    </form>
  );
}

function MemberSelect({
  id,
  members,
  value,
  invalid,
  onChange,
}: {
  id: string;
  members: readonly Member[];
  value: string;
  invalid: boolean;
  onChange: (userId: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      aria-invalid={invalid || undefined}
      aria-describedby={`${id}-message`}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={fieldClass(invalid)}
    >
      {members.map((member) => (
        <option key={member.userId} value={member.userId}>
          {member.displayName}
        </option>
      ))}
    </select>
  );
}
