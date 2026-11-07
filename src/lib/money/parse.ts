import { isCurrencyCode, minorUnitExponent, type CurrencyCode } from "./currency";
import type { Minor } from "./integer";

/**
 * Reading and printing amounts as they appear on screenshots and receipts.
 *
 * Parsing is done with integer string maths only (never parseFloat) and is
 * strict: anything that is not clearly one number is rejected so the import
 * pipeline can flag the row instead of silently fixing it. It understands
 *  - US style   1,234.56
 *  - EU style   1.234,56   1 234,56   (space, no-break and thin spaces)
 *  - Swiss      1'234.56   1’234.56
 *  - plain      1234.56    1234,56
 * with an optional currency symbol or ISO code before or after, and a leading
 * or trailing minus or surrounding parentheses for negative amounts.
 */

export type ParseFailure =
  | "empty"
  | "invalid_format"
  | "too_many_decimals"
  | "out_of_range"
  | "currency_unknown"
  | "currency_unsupported"
  | "currency_mismatch";

export type ParseWarning =
  /** A lone separator followed by exactly three digits was read as thousands (1.234 is 1234). */
  "thousands_inferred";

export type ParseResult =
  | {
      readonly ok: true;
      /** Signed count of minor units. */
      readonly minor: Minor;
      readonly currency: CurrencyCode;
      readonly warnings: readonly ParseWarning[];
    }
  | { readonly ok: false; readonly reason: ParseFailure };

export interface ParseOptions {
  /**
   * The currency the amount is expected to be in. Required when the text carries
   * no symbol or code, or only a bare "$" (SGD and USD both use it): currency is
   * never guessed.
   */
  readonly currency?: CurrencyCode;
}

const SYMBOLS: readonly (readonly [string, CurrencyCode])[] = [
  ["SFr.", "CHF"],
  ["US$", "USD"],
  ["S$", "SGD"],
  ["Fr.", "CHF"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["zł", "PLN"],
  ["Kč", "CZK"],
  ["Ft", "HUF"],
];

const SPACE_LIKE = /[    ]/g;
const MINUS_LIKE = /[−‒–]/g;
const BODY = /^[0-9.,'’ ]+$/;
const GROUPED = /^(\d{1,3})((?:[ '’]\d{3})+)(?:([.,])(\d+))?$/;

interface Currencies {
  symbol?: CurrencyCode;
  code?: string;
  dollar?: true;
}

interface Peeled {
  body: string;
  negative: boolean;
  currencyTokens: Currencies[];
}

/** Strips signs, parentheses and currency tokens from both ends until only the number is left. */
function peel(input: string): Peeled | undefined {
  let text = input.trim();
  let negative = false;
  let signs = 0;
  const currencyTokens: Currencies[] = [];

  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    signs += 1;
    text = text.slice(1, -1).trim();
  }

  for (let guard = 0; guard < 8; guard += 1) {
    const before = text;

    if (text.startsWith("-") || text.startsWith("+")) {
      if (text.startsWith("-")) negative = true;
      signs += 1;
      text = text.slice(1).trim();
    }
    if (text.endsWith("-")) {
      negative = true;
      signs += 1;
      text = text.slice(0, -1).trim();
    }

    for (const [token, currency] of SYMBOLS) {
      if (text.startsWith(token)) {
        currencyTokens.push({ symbol: currency });
        text = text.slice(token.length).trim();
        break;
      }
      if (text.endsWith(token)) {
        currencyTokens.push({ symbol: currency });
        text = text.slice(0, -token.length).trim();
        break;
      }
    }

    if (text.startsWith("$")) {
      currencyTokens.push({ dollar: true });
      text = text.slice(1).trim();
    } else if (text.endsWith("$")) {
      currencyTokens.push({ dollar: true });
      text = text.slice(0, -1).trim();
    }

    const prefixCode = /^([A-Za-z]{3})(?![A-Za-z])/.exec(text);
    if (prefixCode?.[1]) {
      currencyTokens.push({ code: prefixCode[1].toUpperCase() });
      text = text.slice(3).trim();
    }
    const suffixCode = /(?<![A-Za-z])([A-Za-z]{3})$/.exec(text);
    if (suffixCode?.[1]) {
      currencyTokens.push({ code: suffixCode[1].toUpperCase() });
      text = text.slice(0, -3).trim();
    }

    if (text === before) break;
  }

  if (signs > 1 || currencyTokens.length > 1) return undefined;
  return { body: text, negative, currencyTokens };
}

interface Digits {
  integer: string;
  fraction: string;
  warnings: ParseWarning[];
}

function splitDigits(body: string, exponent: number): Digits | ParseFailure {
  const warnings: ParseWarning[] = [];
  const grouped = GROUPED.exec(body);

  if (grouped) {
    const [, head = "", groups = "", , fraction = ""] = grouped;
    if (fraction.length > exponent) return "too_many_decimals";
    const integer = head + groups.replace(/[ '’]/g, "");
    return { integer, fraction, warnings };
  }
  if (/[ '’]/.test(body)) return "invalid_format";

  const dots = body.split(".").length - 1;
  const commas = body.split(",").length - 1;

  if (dots === 0 && commas === 0) {
    return { integer: body, fraction: "", warnings };
  }

  if (dots > 0 && commas > 0) {
    // The rightmost separator is the decimal mark; the other kind groups thousands.
    const decimal = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    const pieces = body.split(decimal);
    if (pieces.length !== 2) return "invalid_format";
    const [intPart = "", fraction = ""] = pieces;
    if (!/^\d+$/.test(fraction)) return "invalid_format";
    if (fraction.length > exponent) return "too_many_decimals";
    const groupPattern = new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})+$`);
    if (!groupPattern.test(intPart)) return "invalid_format";
    return { integer: intPart.split(group).join(""), fraction, warnings };
  }

  const separator = dots > 0 ? "." : ",";
  const count = dots > 0 ? dots : commas;
  const pieces = body.split(separator);

  if (count > 1) {
    const pattern = new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`);
    if (!pattern.test(body)) return "invalid_format";
    return { integer: pieces.join(""), fraction: "", warnings };
  }

  const [integer = "", fraction = ""] = pieces;
  if (!/^\d*$/.test(integer) || !/^\d+$/.test(fraction)) return "invalid_format";
  if (fraction.length <= exponent) return { integer, fraction, warnings };
  if (fraction.length === 3 && /^[1-9]\d{0,2}$/.test(integer)) {
    warnings.push("thousands_inferred");
    return { integer: integer + fraction, fraction: "", warnings };
  }
  return "too_many_decimals";
}

export function parseAmount(text: string, options: ParseOptions = {}): ParseResult {
  const normalized = text.replace(SPACE_LIKE, " ").replace(MINUS_LIKE, "-").trim();
  if (normalized === "") return { ok: false, reason: "empty" };

  const peeled = peel(normalized);
  if (!peeled) return { ok: false, reason: "invalid_format" };

  let detected: CurrencyCode | undefined;
  const token = peeled.currencyTokens[0];
  if (token?.symbol) {
    detected = token.symbol;
  } else if (token?.dollar) {
    // A bare "$" is SGD or USD (or others); only the caller can say which.
    if (!options.currency) return { ok: false, reason: "currency_unknown" };
    if (options.currency !== "SGD" && options.currency !== "USD") {
      return { ok: false, reason: "currency_mismatch" };
    }
    detected = options.currency;
  } else if (token?.code) {
    if (!isCurrencyCode(token.code)) return { ok: false, reason: "currency_unsupported" };
    detected = token.code;
  }

  if (detected && options.currency && detected !== options.currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  const currency = detected ?? options.currency;
  if (!currency) return { ok: false, reason: "currency_unknown" };

  const body = peeled.body;
  if (!BODY.test(body) || !/\d/.test(body)) return { ok: false, reason: "invalid_format" };

  const exponent = minorUnitExponent(currency);
  const digits = splitDigits(body, exponent);
  if (typeof digits === "string") return { ok: false, reason: digits };

  const magnitude = BigInt((digits.integer || "0") + digits.fraction.padEnd(exponent, "0"));
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "out_of_range" };

  const value = Number(magnitude);
  return {
    ok: true,
    minor: peeled.negative && value !== 0 ? -value : value,
    currency,
    warnings: digits.warnings,
  };
}

export interface AmountFormat {
  readonly decimal: "." | ",";
  readonly group: "" | "," | "." | " " | "'";
}

export const AMOUNT_FORMATS = {
  /** 1,234.56 */
  us: { decimal: ".", group: "," },
  /** 1.234,56 */
  eu: { decimal: ",", group: "." },
  /** 1'234.56 */
  swiss: { decimal: ".", group: "'" },
  /** 1234.56 */
  plain: { decimal: ".", group: "" },
} as const satisfies Record<string, AmountFormat>;

/** Prints minor units as a decimal string without currency, e.g. 4850 EUR in eu style is "48,50". */
export function formatAmount(
  minor: Minor,
  currency: CurrencyCode,
  format: AmountFormat = AMOUNT_FORMATS.plain,
): string {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`minor must be a safe integer, got ${String(minor)}`);
  }
  const exponent = minorUnitExponent(currency);
  const magnitude = BigInt(Math.abs(minor))
    .toString()
    .padStart(exponent + 1, "0");
  const integer = magnitude.slice(0, magnitude.length - exponent);
  const fraction = magnitude.slice(magnitude.length - exponent);

  const grouped =
    format.group === "" ? integer : integer.replace(/\B(?=(\d{3})+(?!\d))/g, format.group);
  const body = exponent === 0 ? grouped : `${grouped}${format.decimal}${fraction}`;
  return minor < 0 ? `-${body}` : body;
}
