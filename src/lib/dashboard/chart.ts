import { formatMoney } from "@/lib/ledger";

/**
 * Scale helpers for the hand-rolled SVG charts. Money is integer minor units; the chart only
 * needs ratios, so plain numbers are fine here.
 */

/** A round upper bound for the value axis (1, 2, 2.5, 5 or 10 times a power of ten). Never below `max`. */
export function niceCeiling(max: number): number {
  if (max <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= max) return Math.round(step * power);
  }
  return Math.round(10 * power);
}

/** Which of `count` labels to print so they stay readable: every day for a week, then every nth, always the first. */
export function labelEvery(count: number, maxLabels = 7): number {
  return Math.max(1, Math.ceil(count / maxLabels));
}

/** A money label for an axis: whole dollars when it can be ("S$250"), cents otherwise. */
export function formatAxisMoney(minor: number): string {
  if (minor % 100 !== 0) return formatMoney(minor, "SGD");
  return `S$${(minor / 100).toLocaleString("en-US")}`;
}
