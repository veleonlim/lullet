/** Why a read produced no draft rows. Every one of them leaves an empty draft to fill in by hand. */
export const EXTRACTION_FAILURES = [
  /** The model declined to read the image. */
  "refused",
  /** The answer was cut off at the token limit, so it cannot be trusted whole. */
  "max_tokens",
  /** The answer was not exactly the agreed JSON shape. */
  "malformed",
  /** The service could not be reached or returned an error. */
  "api_error",
  /** No API key is set. */
  "not_configured",
] as const;
export type ExtractionFailure = (typeof EXTRACTION_FAILURES)[number];

export function isExtractionFailure(value: unknown): value is ExtractionFailure {
  return EXTRACTION_FAILURES.some((failure) => failure === value);
}

/** What a person is told when a read failed. */
export const FAILURE_TEXT: Readonly<Record<ExtractionFailure, string>> = {
  refused:
    "The model would not read this image. Add the expenses by hand, or try the stronger re-read.",
  max_tokens:
    "The screenshot has more on it than could be read in one go. Add rows by hand, or try the stronger re-read.",
  malformed:
    "The reply could not be understood. Add the expenses by hand, or try the stronger re-read.",
  api_error:
    "The reading service did not answer. Try again in a moment, or add the expenses by hand.",
  not_configured: "Screenshot reading is not set up yet (no API key). Add the expenses by hand.",
};
