import type { StoredExpense } from "@/lib/ledger/types";
import type { DraftRow } from "./draft";
import type { ExtractionFailure } from "./failure";
import type { BatchSplit } from "./split";

export type ImportStatus = "draft" | "confirmed" | "cancelled" | "expired" | "undone";

/** A draft (or finished import) as the review screen needs it. */
export interface DraftView {
  readonly id: string;
  readonly status: ImportStatus;
  readonly uploaderId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly undoneAt: Date | null;
  /** The model that last read the image, for example claude-haiku-5-5. */
  readonly model: string | null;
  readonly extractionError: ExtractionFailure | null;
  readonly rereads: number;
  /** Remarks from the model about the screenshot as a whole. */
  readonly notes: readonly string[];
  readonly screenTotal: {
    readonly text: string;
    readonly minor: number | null;
    readonly currency: string | null;
  } | null;
  readonly batch: BatchSplit;
  readonly rows: readonly DraftRow[];
  /** Whether the original can still be shown. */
  readonly imageAvailable: boolean;
  /** For a confirmed or undone import: the expenses it created. */
  readonly expenses: readonly StoredExpense[];
}

export interface ImportSummary {
  readonly id: string;
  readonly status: ImportStatus;
  readonly uploaderId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly rowCount: number;
  readonly includedCount: number;
  readonly extractionError: ExtractionFailure | null;
}

export interface ConfirmResult {
  readonly importId: string;
  readonly expenseIds: readonly string[];
  /** Expenses added without an exchange rate yet; they show "No rate" until one is set. */
  readonly unpriced: number;
  /** False when the import had already been confirmed and nothing was added again. */
  readonly added: boolean;
}
