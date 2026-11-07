export type MoneyErrorCode =
  | "empty_split"
  | "duplicate_member"
  | "unknown_member"
  | "invalid_weight"
  | "split_total_mismatch"
  | "percent_total_mismatch"
  | "payer_total_mismatch"
  | "invalid_expense"
  | "invalid_rate"
  | "missing_rate"
  | "unbalanced"
  | "currency_mismatch";

/** A domain rule was broken (as opposed to a programming error). Carries a stable code. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}
