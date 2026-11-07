"use client";

import { useActionState } from "react";
import { rebindMemberAction, type RebindState } from "./actions";

export function RebindForm({ userId, name }: { userId: string; name: string }) {
  const [state, action, pending] = useActionState<RebindState, FormData>(rebindMemberAction, {
    status: "idle",
  });
  const fieldId = `telegram-id-${userId}`;

  return (
    <form action={action} className="mt-3 space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <label htmlFor={fieldId} className="block text-sm text-muted">
        New Telegram user id for {name}
      </label>
      <div className="flex gap-2">
        <input
          id={fieldId}
          name="telegramUserId"
          inputMode="numeric"
          autoComplete="off"
          required
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Re-binding..." : "Re-bind"}
        </button>
      </div>
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {state.message}
        </p>
      ) : null}
      {state.status === "done" ? (
        <p role="status" className="text-sm text-muted">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
