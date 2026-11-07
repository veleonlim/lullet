import type { FieldErrors } from "@/lib/ledger/fields";

/** Failures of the screenshot import layer. Routes turn these into responses people can act on. */
export type ImportErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "expired"
  | "limit"
  | "duplicate_image"
  | "invalid"
  | "unavailable";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export class ImportNotFoundError extends ImportError {
  constructor() {
    super("not_found", "This import was not found");
    this.name = "ImportNotFoundError";
  }
}

/** Only the person who uploaded a screenshot can change, confirm, undo or discard its import. */
export class NotUploaderError extends ImportError {
  constructor() {
    super("forbidden", "Only the person who uploaded this screenshot can do that");
    this.name = "NotUploaderError";
  }
}

export class ImportConflictError extends ImportError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "ImportConflictError";
  }
}

export class DraftExpiredError extends ImportError {
  constructor() {
    super("expired", "This draft expired after 24 hours. Upload the screenshot again.");
    this.name = "DraftExpiredError";
  }
}

export class UploadLimitError extends ImportError {
  constructor(readonly limit: number) {
    super(
      "limit",
      `You have reached today's limit of ${String(limit)} screenshots. Try again tomorrow.`,
    );
    this.name = "UploadLimitError";
  }
}

/** The same image is already a draft or an import: no model call is made for it. */
export class DuplicateImageError extends ImportError {
  constructor(readonly existingImportId: string) {
    super("duplicate_image", "This screenshot was already imported");
    this.name = "DuplicateImageError";
  }
}

export class RereadLimitError extends ImportError {
  constructor() {
    super("limit", "This screenshot has already been read again as many times as allowed");
    this.name = "RereadLimitError";
  }
}

/** A draft that cannot be added yet; carries what to fix on each row. */
export class DraftInvalidError extends ImportError {
  constructor(
    message: string,
    readonly errors: Readonly<Record<string, FieldErrors>>,
  ) {
    super("invalid", message);
    this.name = "DraftInvalidError";
  }
}

/** The original is no longer stored (deleted after retention, or never kept). */
export class ImageGoneError extends ImportError {
  constructor() {
    super("unavailable", "The original screenshot is no longer stored");
    this.name = "ImageGoneError";
  }
}
