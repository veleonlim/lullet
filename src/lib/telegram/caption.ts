/**
 * Reads the caption sent with a screenshot, for example "split between mei and dad" or
 * "paid by mum, except dad". Plain code does this (not the model), so the text a person typed
 * never reaches the model and a caption can only ever choose among the group's own members.
 *
 * Names are matched against an alias table: the member's display name, its first word, any extra
 * aliases the group added, and "me" for the sender. Unknown names are reported back, not guessed.
 */

export type AliasTable = ReadonlyMap<string, string>;

export interface CaptionPlan {
  /** Who paid, when the caption says so. */
  readonly paidBy: readonly string[] | null;
  /** Exactly who shares every row, when the caption says so. */
  readonly splitBetween: readonly string[] | null;
  /** Members to leave out of the default split. */
  readonly exclude: readonly string[];
  /** Words that looked like names but matched nobody. */
  readonly unknown: readonly string[];
}

export const EMPTY_PLAN: CaptionPlan = {
  paidBy: null,
  splitBetween: null,
  exclude: [],
  unknown: [],
};

export function normalizeAlias(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} '.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Builds the lookup from members (in group order) and the extra aliases stored for them. */
export function buildAliasTable(
  members: readonly { userId: string; displayName: string }[],
  extra: readonly { alias: string; userId: string }[],
  senderId: string,
  telegramUsernames: ReadonlyMap<string, string> = new Map(),
): AliasTable {
  const table = new Map<string, string>();
  const add = (alias: string, userId: string) => {
    const key = normalizeAlias(alias);
    // The first claim wins, so a custom alias never steals someone's own name.
    if (key.length >= 2 && !table.has(key)) table.set(key, userId);
  };
  for (const member of members) {
    add(member.displayName, member.userId);
    add(member.displayName.split(/\s+/)[0] ?? "", member.userId);
  }
  for (const [userId, username] of telegramUsernames) add(username, userId);
  for (const { alias, userId } of extra) add(alias, userId);
  for (const word of ["me", "myself", "i"]) table.set(word, senderId);
  return table;
}

const FILLER = new Set(["and", "&", "the", "plus", "also", "to", "all", "of"]);
const KEYWORD =
  /\b(paid by|paid|split(?: it)?(?: between| with| among| amongst)?|between|among|amongst|except|excluding|without|but not)\b/g;

interface Segment {
  readonly keyword: "paid" | "split" | "exclude";
  readonly text: string;
}

function keywordKind(word: string): Segment["keyword"] {
  if (word.startsWith("paid")) return "paid";
  if (word.startsWith("split") || word === "between" || word.startsWith("among")) return "split";
  return "exclude";
}

/** The caption without the command word and any @mention of the bot. */
export function stripTriggers(caption: string, botUsername: string | null): string {
  let text = caption.trim().replace(/^\/[A-Za-z][A-Za-z0-9_]*(?:@[A-Za-z0-9_]+)?/, " ");
  if (botUsername !== null) {
    text = text.replace(new RegExp(`@${botUsername.replace(/[^A-Za-z0-9_]/g, "")}\\b`, "gi"), " ");
  }
  return text;
}

function segments(text: string): Segment[] {
  const lower = ` ${normalizeAlias(text)} `;
  const found = [...lower.matchAll(KEYWORD)];
  const result: Segment[] = [];
  found.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = found[index + 1]?.index ?? lower.length;
    result.push({ keyword: keywordKind(match[0]), text: lower.slice(start, end) });
  });
  return result;
}

/** Longest-match reading of a list of names, up to three words per alias. */
function readNames(text: string, table: AliasTable): { ids: string[]; unknown: string[] } {
  const words = text.split(/[\s,+]+/).filter((word) => word !== "" && !FILLER.has(word));
  const ids: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < words.length;) {
    let matched = false;
    for (let size = Math.min(3, words.length - i); size >= 1; size -= 1) {
      const id = table.get(words.slice(i, i + size).join(" "));
      if (id !== undefined) {
        if (!ids.includes(id)) ids.push(id);
        i += size;
        matched = true;
        break;
      }
    }
    if (!matched) {
      unknown.push(words[i] ?? "");
      i += 1;
    }
  }
  return { ids, unknown };
}

export function parseCaption(
  caption: string | null,
  botUsername: string | null,
  table: AliasTable,
): CaptionPlan {
  if (caption === null) return EMPTY_PLAN;
  let paidBy: string[] | null = null;
  let splitBetween: string[] | null = null;
  const exclude: string[] = [];
  const unknown: string[] = [];
  for (const segment of segments(stripTriggers(caption, botUsername))) {
    const { ids, unknown: missed } = readNames(segment.text, table);
    unknown.push(...missed);
    if (ids.length === 0) continue;
    if (segment.keyword === "paid") paidBy = [...(paidBy ?? []), ...ids];
    else if (segment.keyword === "split") splitBetween = [...(splitBetween ?? []), ...ids];
    else exclude.push(...ids);
  }
  return {
    paidBy: paidBy && [...new Set(paidBy)],
    splitBetween: splitBetween && [...new Set(splitBetween)],
    exclude: [...new Set(exclude)],
    unknown: [...new Set(unknown)],
  };
}

export function isEmptyPlan(plan: CaptionPlan): boolean {
  return plan.paidBy === null && plan.splitBetween === null && plan.exclude.length === 0;
}
