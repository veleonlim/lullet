import type { CurrencyCode } from "@/lib/money/currency";
import type { IsoDate } from "@/lib/money/dates";
import type { Rate } from "@/lib/money/rate";

export interface FxRateQuote {
  readonly provider: string;
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** The day that was asked for. */
  readonly requestedDate: IsoDate;
  /** The day the rate is actually from. Differs on weekends and holidays (the last business day). */
  readonly rateDate: IsoDate;
  /** Units of `quote` per 1 unit of `base`. */
  readonly rate: Rate;
}

/** A source of historical market rates. Implementations must not return a rate dated after the request. */
export interface FxRateClient {
  getRate(date: IsoDate, base: CurrencyCode, quote: CurrencyCode): Promise<FxRateQuote>;
}

export type FxRateErrorCode =
  /** No rate exists for that day or pair (for example before the dataset starts). */
  "not_found" | "http_error" | "network_error" | "timeout" | "invalid_response";

export class FxRateError extends Error {
  readonly code: FxRateErrorCode;

  constructor(code: FxRateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FxRateError";
    this.code = code;
  }
}
