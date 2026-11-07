import type { MemberId } from "./allocate";
import { MoneyError } from "./errors";
import { sum, type Minor } from "./integer";

/**
 * Settle-up suggestions: the fewest payments that bring every balance to zero.
 * Balances are derived, so this is only a view and never changes the ledger.
 */

export interface Transfer {
  readonly fromMemberId: MemberId;
  readonly toMemberId: MemberId;
  readonly minor: Minor;
}

export interface BalanceEntry {
  readonly memberId: MemberId;
  /** Positive: is owed money. Negative: owes money. */
  readonly balanceMinor: Minor;
}

/**
 * Up to this many people with a non-zero balance the answer is provably the
 * minimum. Beyond it a greedy answer (at most n - 1 transfers) is used.
 */
export const EXACT_SETTLE_LIMIT = 14;

interface Person {
  readonly memberId: MemberId;
  readonly index: number;
  balance: number;
}

export function suggestTransfers(balances: readonly BalanceEntry[]): Transfer[] {
  if (sum(balances.map((entry) => entry.balanceMinor)) !== 0) {
    throw new MoneyError("unbalanced", "Balances must sum to zero to settle up");
  }
  const people: Person[] = balances
    .map((entry, index) => ({ memberId: entry.memberId, index, balance: entry.balanceMinor }))
    .filter((person) => person.balance !== 0);

  const groups = people.length <= EXACT_SETTLE_LIMIT ? splitIntoZeroSumGroups(people) : [people];

  const transfers = groups.flatMap((group) => settleGroup(group));
  const position = new Map(balances.map((entry, index) => [entry.memberId, index] as const));
  return transfers.sort(
    (a, b) =>
      (position.get(a.fromMemberId) ?? 0) - (position.get(b.fromMemberId) ?? 0) ||
      (position.get(a.toMemberId) ?? 0) - (position.get(b.toMemberId) ?? 0),
  );
}

/**
 * Partitions people into the largest possible number of groups whose balances
 * each sum to zero. Fewer transfers are needed the more groups there are:
 * transfers = people - groups. Subset DP over bitmasks; ties pick the lowest
 * index so the result is deterministic.
 */
function splitIntoZeroSumGroups(people: readonly Person[]): Person[][] {
  const n = people.length;
  if (n === 0) return [];
  const size = 1 << n;
  const sums = new Array<number>(size).fill(0);
  const best = new Array<number>(size).fill(0);

  for (let mask = 1; mask < size; mask += 1) {
    const low = mask & -mask;
    sums[mask] = (sums[mask ^ low] ?? 0) + (people[31 - Math.clz32(low)]?.balance ?? 0);
    let top = 0;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) top = Math.max(top, best[mask ^ (1 << i)] ?? 0);
    }
    best[mask] = top + (sums[mask] === 0 ? 1 : 0);
  }

  // Walk back from the full set, removing one person at a time along an optimal chain.
  const removed: number[] = [];
  let mask = size - 1;
  while (mask !== 0) {
    const target = (best[mask] ?? 0) - (sums[mask] === 0 ? 1 : 0);
    let pick = -1;
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i) && (best[mask ^ (1 << i)] ?? 0) === target) {
        pick = i;
        break;
      }
    }
    removed.push(pick);
    mask ^= 1 << pick;
  }

  // Adding people back in reverse, every time the running sum hits zero a group is complete.
  const groups: Person[][] = [];
  let current: Person[] = [];
  let running = 0;
  for (const index of removed.reverse()) {
    const person = people[index];
    if (!person) continue;
    current.push(person);
    running += person.balance;
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

/** Greedy within a zero-sum group: largest debtor pays largest creditor. */
function settleGroup(group: readonly Person[]): Transfer[] {
  const debtors = group.filter((p) => p.balance < 0).map((p) => ({ ...p, balance: -p.balance }));
  const creditors = group.filter((p) => p.balance > 0).map((p) => ({ ...p }));
  const byLargest = (a: Person, b: Person) => b.balance - a.balance || a.index - b.index;

  const transfers: Transfer[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort(byLargest);
    creditors.sort(byLargest);
    const debtor = debtors[0] as Person;
    const creditor = creditors[0] as Person;
    const minor = Math.min(debtor.balance, creditor.balance);
    transfers.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, minor });
    debtor.balance -= minor;
    creditor.balance -= minor;
    if (debtor.balance === 0) debtors.shift();
    if (creditor.balance === 0) creditors.shift();
  }
  return transfers;
}
