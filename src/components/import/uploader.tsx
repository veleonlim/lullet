"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { MAX_UPLOAD_BYTES } from "@/lib/import/policy";
import { route } from "@/lib/routes";
import { ApiError, uploadScreenshotRequest } from "./api";
import { Button, Notice } from "../ui";

const ACCEPT = "image/png,image/jpeg,image/webp";
const KINDS = new Set(ACCEPT.split(","));
/** Larger photos are shrunk in the browser first; the server accepts at most MAX_UPLOAD_BYTES. */
const SHRINK_ABOVE = 3_500_000;
const LONG_EDGE = 2400;

/**
 * Photos from a camera can be large and carry an orientation flag. Redrawing a JPEG (or a very
 * large PNG) through a canvas applies the orientation, drops all metadata, and keeps it under the
 * upload limit. Ordinary screenshots go up exactly as they are.
 */
async function prepare(file: File): Promise<{ blob: Blob; name: string }> {
  const needsWork = file.type === "image/jpeg" || file.size > SHRINK_ABOVE;
  if (!needsWork) return { blob: file, name: file.name };
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.9);
    });
    if (blob && (blob.size < file.size || file.size > SHRINK_ABOVE)) {
      return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
    }
  } catch {
    // Fall through: the server checks the original.
  }
  return { blob: file, name: file.name };
}

export function ImportUploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; existing?: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Revoke the preview's object URL when it is replaced and when the page goes away.
  const previewUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  function show(chosen: File | null) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = chosen ? URL.createObjectURL(chosen) : null;
    setFile(chosen);
    setPreview(previewUrl.current);
  }

  function choose(chosen: File | undefined) {
    setProblem(null);
    if (!chosen) return;
    if (!KINDS.has(chosen.type)) {
      show(null);
      setProblem({ message: "Upload a PNG, JPEG or WebP screenshot" });
      return;
    }
    show(chosen);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const { blob, name } = await prepare(file);
      if (blob.size > MAX_UPLOAD_BYTES) {
        setProblem({ message: "That file is too large. The limit is 4 MB" });
        setBusy(false);
        return;
      }
      const { id } = await uploadScreenshotRequest(blob, name);
      router.push(route(`/imports/${id}`));
    } catch (error) {
      if (error instanceof ApiError) {
        setProblem({ message: error.problem.message, existing: error.problem.existingImportId });
      } else {
        setProblem({ message: "Something went wrong. Try again." });
      }
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Upload a screenshot of your bank or card app, a payment confirmation or a receipt. lullet
        reads it into a draft you can check and change before anything is added.
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
        className={`rounded-2xl border-2 border-dashed p-4 transition-colors ${
          dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-surface"
        }`}
      >
        <input
          ref={input}
          id="screenshot"
          type="file"
          accept={ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            choose(event.target.files?.[0]);
          }}
        />
        {preview ? (
          <div className="flex flex-col items-center gap-3">
            {/* A local preview of the chosen file; there is nothing for next/image to optimise. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="The screenshot you chose"
              className="max-h-72 w-auto max-w-full rounded-lg border border-border object-contain"
            />
            <p className="max-w-full truncate text-sm text-muted">{file?.name}</p>
            <label
              htmlFor="screenshot"
              className="inline-flex min-h-11 cursor-pointer items-center rounded-xl px-4 text-sm font-semibold text-accent hover:bg-accent-soft"
            >
              Choose a different one
            </label>
          </div>
        ) : (
          <label
            htmlFor="screenshot"
            className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl px-4 py-8 text-center"
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />
              </svg>
            </span>
            <span className="text-base font-semibold">Choose a screenshot</span>
            <span className="text-sm text-muted">PNG, JPEG or WebP, up to 4 MB</span>
          </label>
        )}
      </div>

      {problem ? (
        <Notice
          tone="error"
          role="alert"
          action={
            problem.existing ? (
              <Link
                href={route(`/imports/${problem.existing}`)}
                className="text-sm font-semibold text-accent underline underline-offset-2"
              >
                Open it
              </Link>
            ) : undefined
          }
        >
          {problem.message}
        </Notice>
      ) : null}

      <div aria-live="polite" className="min-h-6 text-sm text-muted">
        {busy ? "Reading your screenshot… this takes a few seconds." : null}
      </div>

      <Button
        variant="primary"
        className="w-full sm:w-auto"
        disabled={!file || busy}
        aria-busy={busy}
        onClick={() => {
          void submit();
        }}
      >
        {busy ? "Reading…" : "Read screenshot"}
      </Button>
    </div>
  );
}
