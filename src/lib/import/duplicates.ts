import { dayDistance } from "./days";

/**
 * Layer two and three of duplicate detection (layer one is the image hash). A draft row is a
 * possible duplicate of an existing record when the amount, currency, day (within one day) and
 * merchant (fuzzy) all match. Candidates are the ledger's expenses and the rows of other open
 * drafts, which also catches two overlapping screenshots of one scrolled list.
 *
 * A match only ever flags and unchecks a row; nothing is dropped. The payer is not required to
 * match, because the same bill entered by one person and screenshotted by another is exactly the
 * duplicate worth catching; a matching payer just ranks higher.
 */

export interface DuplicateCandidate {
  /** "expense" for a ledger expense, "draft" for a row of another open draft. */
  readonly kind: "expense" | "draft";
  /** The expense id, or the draft row id. */
  readonly id: string;
  /** For a draft row: the import it belongs to. */
  readonly importId: string | null;
  readonly merchant: string;
  readonly spentOn: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billedAmountMinor: number | null;
  readonly billedCurrency: string | null;
  readonly payerIds: readonly string[];
}

export interface DuplicateProbe {
  readonly merchant: string | null;
  readonly spentOn: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly billedAmountMinor: number | null;
  readonly billedCurrency: string | null;
}

export interface DuplicateMatch {
  readonly candidate: DuplicateCandidate;
  readonly samePayer: boolean;
}

const NOISE_WORDS = new Set([
  "the",
  "of",
  "and",
  "srl",
  "spa",
  "ltd",
  "gmbh",
  "ag",
  "sa",
  "inc",
  "co",
  "pte",
  "llc",
  "sarl",
  "restaurant",
  "ristorante",
  "cafe",
  "bar",
  "shop",
  "store",
  "payment",
  "card",
  "pos",
]);

/** Lowercase letters and digits only, words split by single spaces, noise words removed. */
export function merchantWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word !== "" && !NOISE_WORDS.has(word));
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Whether two merchant names plausibly name the same place ("AMZN Mktp" vs "Amazon Marketplace" does not; "Trattoria Roma" vs "TRATTORIA ROMA SRL" does). */
export function merchantsMatch(a: string | null, b: string): boolean {
  if (a === null) return false;
  const left = merchantWords(a);
  const right = merchantWords(b);
  if (left.length === 0 || right.length === 0) return false;
  const joinedLeft = left.join("");
  const joinedRight = right.join("");
  if (joinedLeft === joinedRight) return true;
  const [short, long] =
    joinedLeft.length <= joinedRight.length ? [joinedLeft, joinedRight] : [joinedRight, joinedLeft];
  if (short.length >= 4 && long.includes(short)) return true;

  const shared = left.filter((word) => right.includes(word)).length;
  const union = new Set([...left, ...right]).size;
  if (shared / union >= 0.5) return true;

  const distance = levenshtein(joinedLeft, joinedRight);
  return 1 - distance / Math.max(joinedLeft.length, joinedRight.length) >= 0.75;
}

function amountsOverlap(probe: DuplicateProbe, candidate: DuplicateCandidate): boolean {
  const mine: [string, number][] = [];
  if (probe.currency !== null && probe.amountMinor !== null)
    mine.push([probe.currency, probe.amountMinor]);
  if (probe.billedCurrency !== null && probe.billedAmountMinor !== null) {
    mine.push([probe.billedCurrency, probe.billedAmountMinor]);
  }
  const theirs: [string, number][] = [[candidate.currency, candidate.amountMinor]];
  if (candidate.billedCurrency !== null && candidate.billedAmountMinor !== null) {
    theirs.push([candidate.billedCurrency, candidate.billedAmountMinor]);
  }
  return mine.some(([currency, minor]) => theirs.some(([c, m]) => c === currency && m === minor));
}

/** The best matching record for a draft row, or null. `payerIds` are the draft's payers. */
export function findDuplicate(
  probe: DuplicateProbe,
  candidates: readonly DuplicateCandidate[],
  payerIds: readonly string[],
): DuplicateMatch | null {
  if (probe.spentOn === null) return null;
  const spentOn = probe.spentOn;
  const matches = candidates
    .filter(
      (candidate) =>
        dayDistance(candidate.spentOn, spentOn) <= 1 &&
        amountsOverlap(probe, candidate) &&
        merchantsMatch(probe.merchant, candidate.merchant),
    )
    .map((candidate) => ({
      candidate,
      samePayer: candidate.payerIds.some((id) => payerIds.includes(id)),
    }));
  if (matches.length === 0) return null;
  const rank = (match: DuplicateMatch): number =>
    (match.samePayer ? 4 : 0) +
    (match.candidate.spentOn === spentOn ? 2 : 0) +
    (match.candidate.kind === "expense" ? 1 : 0);
  return matches.reduce((best, match) => (rank(match) > rank(best) ? match : best));
}
