"use client";

import { useActionState } from "react";
import { dayRateAction, type RateState } from "@/app/rates/actions";
import { AmountInput, Field } from "./form-controls";
import { Button, Notice } from "./ui";

const NOTHING: RateState = { errors: {} };

function Result({ state }: { state: RateState }) {
  if (state.errors.form) {
    return (
      <Notice tone="error" role="alert">
        {state.errors.form}
      </Notice>
    );
  }
  if (!state.message) return null;
  return (
    <Notice tone="success" role="status">
      <p data-testid="rate-result">{state.message}</p>
      {state.changes && state.changes.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
          {state.changes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

/**
 * The controls for one day and currency: set the day's default rate, drop it, or re-price the
 * day. All three report what they did, including every expense whose SGD figure moved.
 */
export function DayRateControls({
  day,
  currency,
  override,
  market,
  affected,
}: {
  day: string;
  currency: string;
  /** The group's default rate for the day, if set. */
  override: string | null;
  /** The stored market rate, if one has been fetched. */
  market: string | null;
  /** Expenses on the day that this rate prices. */
  affected: number;
}) {
  const [state, action, pending] = useActionState(dayRateAction, NOTHING);
  const id = `rate-${day}-${currency}`;

  return (
    <form action={action} noValidate className="space-y-3 border-t border-border px-4 py-4">
      <input type="hidden" name="day" value={day} />
      <input type="hidden" name="currency" value={currency} />
      <Field
        label={`SGD per 1 ${currency}`}
        htmlFor={id}
        error={state.errors.rate}
        hint={
          market
            ? `Market rate S$${market}. Your rate beats it for expenses on this day.`
            : "No market rate is stored for this day yet."
        }
      >
        <AmountInput
          id={id}
          name="rate"
          defaultValue={override ?? ""}
          placeholder={market ?? "e.g. 1.5340"}
          invalid={Boolean(state.errors.rate)}
          aria-describedby={`${id}-message`}
        />
      </Field>
      <p className="text-sm text-muted">
        {affected === 0
          ? "No expense on this day is priced from this rate."
          : `Prices ${String(affected)} ${affected === 1 ? "expense" : "expenses"} on this day. Expenses billed in SGD or with their own rate keep their figure.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          name="intent"
          value="save"
          variant="primary"
          disabled={pending}
          className="min-h-10"
        >
          Save rate
        </Button>
        {override ? (
          <Button
            type="submit"
            name="intent"
            value="clear"
            variant="secondary"
            disabled={pending}
            className="min-h-10"
          >
            Use the market rate
          </Button>
        ) : null}
        <Button
          type="submit"
          name="intent"
          value="reprice"
          variant="secondary"
          disabled={pending}
          className="min-h-10"
        >
          Re-price this day
        </Button>
      </div>
      <Result state={state} />
    </form>
  );
}
