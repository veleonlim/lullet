import { dailyWindowStart, MAX_UPLOAD_BYTES } from "@/lib/import/policy";
import { imageExtension, inspectImage, sha256Hex, type ImageFailure } from "@/lib/import/image";
import { todayIn } from "@/lib/ledger/days";
import type { DraftView } from "@/lib/import/view";
import { DuplicateImageError, ImageGoneError, ImportError, UploadLimitError } from "./errors";
import { EXTRACTION_MODELS, type ImageExtractor } from "./extract/types";
import type { ImportStore } from "./store";
import { storageKeyFor, type ImageStorage } from "./storage/types";

/**
 * The import pipeline: take an upload, store the original privately, have the model read it,
 * and leave a draft for a person to review. Everything the pipeline needs is passed in, so the
 * same code runs behind the web routes (and later the Telegram bot) and in tests.
 */

export interface ImportDeps {
  readonly store: ImportStore;
  readonly storage: ImageStorage;
  readonly extractor: ImageExtractor;
  /** Uploads per person per rolling day. */
  readonly dailyLimit: number;
  readonly groupId: string;
  readonly now?: () => Date;
}

const IMAGE_PROBLEMS: Readonly<Record<ImageFailure, string>> = {
  unsupported_type: "Upload a PNG, JPEG or WebP screenshot",
  corrupt: "That image could not be read. Try taking the screenshot again",
  too_large_dimensions: "That image is too large. Crop it or take a smaller screenshot",
  too_small: "That image is too small to read",
};

export interface UploadInput {
  readonly bytes: Uint8Array;
  readonly source: "web" | "telegram";
  readonly caption?: string | null;
}

export interface UploadResult {
  readonly importId: string;
  /** True when the read failed and the draft is empty, to be filled in by hand. */
  readonly empty: boolean;
}

export async function uploadScreenshot(
  deps: ImportDeps,
  input: UploadInput,
): Promise<UploadResult> {
  const now = deps.now ?? (() => new Date());
  if (input.bytes.length === 0) throw new ImportError("invalid", "Choose a screenshot to upload");
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ImportError("invalid", "That file is too large. The limit is 4 MB");
  }

  // Look at the real bytes, never the file name or declared type, and drop all metadata.
  const image = inspectImage(input.bytes);
  if (!image.ok) throw new ImportError("invalid", IMAGE_PROBLEMS[image.reason]);

  const sha = await sha256Hex(image.clean);
  // The same image is rejected before any model call is made for it.
  const existing = await deps.store.findActiveByHash(sha);
  if (existing) throw new DuplicateImageError(existing.id);

  const used = await deps.store.countUploadsSince(dailyWindowStart(now()));
  if (used >= deps.dailyLimit) throw new UploadLimitError(deps.dailyLimit);

  const importId = crypto.randomUUID();
  const key = storageKeyFor(deps.groupId, importId, imageExtension(image.type));
  await deps.storage.put(key, image.clean, image.type);

  try {
    const today = todayIn(now());
    const outcome = await deps.extractor.extract({
      bytes: image.clean,
      mediaType: image.type,
      model: EXTRACTION_MODELS.default,
      today,
    });
    await deps.store.createDraft({
      importId,
      source: input.source,
      imageSha256: sha,
      storageKey: key,
      mediaType: image.type,
      byteSize: image.clean.length,
      caption: input.caption ?? null,
      outcome,
      today,
    });
    return { importId, empty: !outcome.ok || outcome.extraction.transactions.length === 0 };
  } catch (error) {
    // Nothing refers to the stored original any more.
    await deps.storage.delete(key).catch(() => undefined);
    throw error;
  }
}

/** The one-tap stronger read. A failed read leaves the draft untouched. */
export async function rereadScreenshot(
  deps: ImportDeps,
  importId: string,
): Promise<{ view: DraftView; failed: boolean }> {
  const now = deps.now ?? (() => new Date());
  const info = await deps.store.beginReread(importId);
  const stored = await deps.storage.get(info.storageKey);
  if (!stored) throw new ImageGoneError();
  const today = todayIn(now());
  const outcome = await deps.extractor.extract({
    bytes: stored.bytes,
    mediaType: info.mediaType as "image/png" | "image/jpeg" | "image/webp",
    model: EXTRACTION_MODELS.reread,
    today,
  });
  const view = await deps.store.applyReread(importId, outcome, today);
  return { view, failed: !outcome.ok };
}

/** Discards a draft and deletes its original straight away (retention sweeps up if that fails). */
export async function cancelImport(deps: ImportDeps, importId: string): Promise<void> {
  const { storageKey } = await deps.store.cancel(importId);
  if (storageKey === null) return;
  try {
    await deps.storage.delete(storageKey);
    await deps.store.markImageDeleted(importId);
  } catch {
    // The retention job deletes anything left behind.
  }
}
