"use client";

import { useActionState, useState } from "react";
import { saveBudgetAction, saveTripAction, type SettingsState } from "@/app/budget/actions";
import { AmountInput, Field, fieldClass } from "./form-controls";
import { Button, Notice } from "./ui";

const NOTHING: SettingsState = { errors: {} };

function Result({ state }: { state: SettingsState }) {
  if (state.errors.form) {
    return (
      <Notice tone="error" role="alert">
        {state.errors.form}
      </Notice>
    );
  }
  return state.saved ? (
    <Notice tone="success" role="status">
      {state.saved}.
    </Notice>
  ) : null;
}

/** The default daily budget for every day without a budget of its own. */
export function DefaultBudgetForm({ initial }: { initial: string }) {
  const [state, action, pending] = useActionState(saveBudgetAction.bind(null, false), NOTHING);
  const [amount, setAmount] = useState(initial);
  return (
    <form action={action} noValidate className="space-y-3">
      <Field
        label="Budget per day (SGD)"
        htmlFor="default-amount"
        error={state.errors.amount}
        hint="For the whole group. Each person's share is compared with this divided by the number of members."
      >
        <AmountInput
          id="default-amount"
          name="amount"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
          placeholder="e.g. 250"
          invalid={Boolean(state.errors.amount)}
          aria-describedby="default-amount-message"
        />
      </Field>
      <Result state={state} />
      <Button type="submit" variant="primary" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving..." : "Save daily budget"}
      </Button>
    </form>
  );
}

/** A budget for one particular day, instead of the default. */
export function DayBudgetForm({ firstDay }: { firstDay: string }) {
  const [state, action, pending] = useActionState(saveBudgetAction.bind(null, true), NOTHING);
  const [day, setDay] = useState(firstDay);
  const [amount, setAmount] = useState("");
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.saved) {
      setDay(firstDay);
      setAmount("");
    }
  }
  return (
    <form action={action} noValidate className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Day" htmlFor="override-day" error={state.errors.day}>
          <input
            id="override-day"
            name="day"
            type="date"
            value={day}
            onChange={(event) => {
              setDay(event.target.value);
            }}
            aria-invalid={Boolean(state.errors.day) || undefined}
            aria-describedby="override-day-message"
            className={fieldClass(Boolean(state.errors.day))}
          />
        </Field>
        <Field
          label="Budget for that day (SGD)"
          htmlFor="override-amount"
          error={state.errors.amount}
        >
          <AmountInput
            id="override-amount"
            name="amount"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
            placeholder="e.g. 400"
            invalid={Boolean(state.errors.amount)}
            aria-describedby="override-amount-message"
          />
        </Field>
      </div>
      <Result state={state} />
      <Button type="submit" variant="secondary" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving..." : "Set budget for this day"}
      </Button>
    </form>
  );
}

export function TripForm({
  initial,
  zones,
}: {
  initial: { tripStart: string | null; tripEnd: string | null; timeZone: string };
  zones: readonly string[];
}) {
  const [state, action, pending] = useActionState(saveTripAction, NOTHING);
  const [tripStart, setTripStart] = useState(initial.tripStart ?? "");
  const [tripEnd, setTripEnd] = useState(initial.tripEnd ?? "");
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const options = zones.includes(initial.timeZone) ? zones : [initial.timeZone, ...zones];
  return (
    <form action={action} noValidate className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First day" htmlFor="trip-start" error={state.errors.tripStart}>
          <input
            id="trip-start"
            name="tripStart"
            type="date"
            value={tripStart}
            onChange={(event) => {
              setTripStart(event.target.value);
            }}
            aria-invalid={Boolean(state.errors.tripStart) || undefined}
            aria-describedby="trip-start-message"
            className={fieldClass(Boolean(state.errors.tripStart))}
          />
        </Field>
        <Field label="Last day" htmlFor="trip-end" error={state.errors.tripEnd}>
          <input
            id="trip-end"
            name="tripEnd"
            type="date"
            value={tripEnd}
            onChange={(event) => {
              setTripEnd(event.target.value);
            }}
            aria-invalid={Boolean(state.errors.tripEnd) || undefined}
            aria-describedby="trip-end-message"
            className={fieldClass(Boolean(state.errors.tripEnd))}
          />
        </Field>
      </div>
      <Field
        label="Time zone"
        htmlFor="trip-zone"
        error={state.errors.timeZone}
        hint="Decides which day counts as today."
      >
        <select
          id="trip-zone"
          name="timeZone"
          value={timeZone}
          onChange={(event) => {
            setTimeZone(event.target.value);
          }}
          aria-describedby="trip-zone-message"
          className={fieldClass(Boolean(state.errors.timeZone))}
        >
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </Field>
      <Result state={state} />
      <Button type="submit" variant="secondary" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving..." : "Save trip"}
      </Button>
    </form>
  );
}
