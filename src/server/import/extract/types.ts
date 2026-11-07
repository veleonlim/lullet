import type { Extraction } from "@/lib/import/extraction";
import type { ExtractionFailure } from "@/lib/import/failure";
import type { ImageType } from "@/lib/import/image";

/** Claude Haiku 5.5 reads every screenshot first; Sonnet 5.5 is the one-tap second opinion. */
export const EXTRACTION_MODELS = {
  default: "claude-haiku-5-5",
  reread: "claude-sonnet-5-5",
} as const;
export type ExtractionModel = (typeof EXTRACTION_MODELS)[keyof typeof EXTRACTION_MODELS];

export type ExtractionOutcome =
  | { readonly ok: true; readonly model: string; readonly extraction: Extraction }
  | { readonly ok: false; readonly model: string; readonly failure: ExtractionFailure };

export interface ExtractionRequest {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageType;
  readonly model: ExtractionModel;
  /** Today's calendar day, to help with years and words like "Today". */
  readonly today: string;
}

/** Reads a screenshot. Never throws: every failure is an outcome. */
export interface ImageExtractor {
  extract(request: ExtractionRequest): Promise<ExtractionOutcome>;
}

export type { ExtractionFailure };
