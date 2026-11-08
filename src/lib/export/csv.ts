/**
 * CSV for spreadsheets (RFC 4180 quoting, CRLF line ends, a UTF-8 byte order mark so Excel reads
 * accents correctly). Text that a spreadsheet could take for a formula is prefixed with an
 * apostrophe, so a description like `=HYPERLINK(...)` typed into the app stays plain text.
 */

export type CsvCell = string | number | boolean | Date | null | undefined;

const BYTE_ORDER_MARK = "﻿";
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function text(value: string): string {
  const risky = /^[=+@\t\r]/.test(value) || (value.startsWith("-") && !PLAIN_NUMBER.test(value));
  return risky ? `'${value}` : value;
}

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let cell: string;
  if (value instanceof Date) cell = value.toISOString();
  else if (typeof value === "string") cell = text(value);
  else cell = String(value);
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** One header row and the given rows, each an array in the order of `columns`. */
export function toCsv(columns: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [columns, ...rows].map((row) => row.map(csvCell).join(","));
  return `${BYTE_ORDER_MARK}${lines.join("\r\n")}\r\n`;
}
