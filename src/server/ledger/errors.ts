/** Failures of the ledger data layer. Pages and actions turn these into messages. */

export class LedgerError extends Error {
  constructor(
    readonly code: "not_a_member" | "not_found" | "invalid_reference" | "conflict" | "no_rate",
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** The signed-in user does not belong to the session's group. */
export class NotAMemberError extends LedgerError {
  constructor() {
    super("not_a_member", "You are not a member of this group");
    this.name = "NotAMemberError";
  }
}

/** The record does not exist in the caller's group (or does not exist at all: the two look alike). */
export class NotFoundError extends LedgerError {
  constructor(what: string) {
    super("not_found", `${what} was not found`);
    this.name = "NotFoundError";
  }
}

/** A payer, sharer or settlement party that is not a member of the caller's group. */
export class InvalidReferenceError extends LedgerError {
  constructor() {
    super("invalid_reference", "Someone who is not a member of this group was selected");
    this.name = "InvalidReferenceError";
  }
}

/** The record changed since it was loaded (or is deleted), so the write was refused. */
export class ConflictError extends LedgerError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "ConflictError";
  }
}

/** The SGD figure needs an exchange rate that is not stored and could not be fetched. */
export class RateUnavailableError extends LedgerError {
  constructor(
    readonly currency: string,
    readonly date: string,
  ) {
    super("no_rate", `No ${currency} to SGD rate is available for ${date}`);
    this.name = "RateUnavailableError";
  }
}
