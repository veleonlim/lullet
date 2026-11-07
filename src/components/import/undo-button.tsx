"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, undoRequest } from "./api";
import { Button, Notice } from "../ui";

/** "Undo import": soft deletes the whole batch, after one more tap to be sure. */
export function UndoImportButton({ importId, count }: { importId: string; count: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      await undoRequest(importId);
      router.refresh();
    } catch (problem) {
      setError(
        problem instanceof ApiError ? problem.problem.message : "Something went wrong. Try again.",
      );
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <Button
        variant="danger"
        onClick={() => {
          setAsking(true);
        }}
      >
        Undo import
      </Button>
    );
  }
  return (
    <div className="space-y-3">
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
      <div
        role="alertdialog"
        aria-label="Undo this import?"
        className="flex flex-wrap items-center gap-2"
      >
        <p className="mr-auto text-sm font-medium">
          Delete the {count} {count === 1 ? "expense" : "expenses"} this import added?
        </p>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setAsking(false);
          }}
        >
          Keep them
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            void undo();
          }}
        >
          {busy ? "Undoing…" : "Yes, undo the import"}
        </Button>
      </div>
    </div>
  );
}
