import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import {
  isSplitStep,
  readSplitState,
  type SplitState,
  type SplitStep,
} from "@/lib/telegram/split/state";

/**
 * Where a /split conversation lives between messages. A member has at most one open flow
 * (`telegram_split_flows`, unique per member); every write is keyed by the flow's `version`, so two
 * taps that arrive together take turns instead of overwriting each other.
 */

/** A flow nobody answers for this long is over. */
export const SPLIT_FLOW_TTL_MS = 30 * 60_000;

/** An expired flow's row stays this long, so a late answer can be told what happened. */
const EXPIRED_KEEP_MS = 24 * 3_600_000;

/** Between the Confirm tap and the expense being saved; no other tap changes the flow meanwhile. */
export const CONFIRMING = "confirming";

/** Saving takes seconds; a flow still `confirming` after this long lost its handler and reads as `summary` again. */
export const CONFIRM_STALE_MS = 2 * 60_000;

export interface SplitFlow {
  readonly id: string;
  readonly groupId: string;
  readonly userId: string;
  readonly chatId: number;
  /** The message showing the current question. */
  readonly messageId: number | null;
  readonly step: SplitStep | typeof CONFIRMING;
  readonly state: SplitState;
  readonly version: number;
}

export type FlowLookup =
  | { readonly kind: "none" }
  | { readonly kind: "expired" }
  | { readonly kind: "open"; readonly flow: SplitFlow };

function toFlow(row: typeof s.telegramSplitFlows.$inferSelect): SplitFlow | null {
  const state = readSplitState(row.state);
  const step = row.step === CONFIRMING ? CONFIRMING : isSplitStep(row.step) ? row.step : null;
  if (!state || step === null) return null;
  return {
    id: row.id,
    groupId: row.groupId,
    userId: row.userId,
    chatId: row.chatId,
    messageId: row.messageId,
    step,
    state,
    version: row.version,
  };
}

/** The member's flow, with an expired or unreadable one removed and reported as such, and a stale `confirming` one released. */
export async function findFlow(
  db: Database,
  who: { readonly groupId: string; readonly userId: string },
  now: Date,
): Promise<FlowLookup> {
  await db
    .update(s.telegramSplitFlows)
    .set({ step: "summary", version: sql`${s.telegramSplitFlows.version} + 1`, updatedAt: now })
    .where(
      and(
        eq(s.telegramSplitFlows.groupId, who.groupId),
        eq(s.telegramSplitFlows.userId, who.userId),
        eq(s.telegramSplitFlows.step, CONFIRMING),
        lt(s.telegramSplitFlows.updatedAt, new Date(now.getTime() - CONFIRM_STALE_MS)),
      ),
    );
  const [row] = await db
    .select()
    .from(s.telegramSplitFlows)
    .where(
      and(
        eq(s.telegramSplitFlows.groupId, who.groupId),
        eq(s.telegramSplitFlows.userId, who.userId),
      ),
    );
  if (!row) return { kind: "none" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { kind: "expired" };
  }
  const flow = toFlow(row);
  if (!flow) {
    await deleteFlow(db, row.id);
    return { kind: "none" };
  }
  return { kind: "open", flow };
}

/** Starts a new flow, replacing the member's old one (its buttons then stop working). */
export async function startFlow(
  db: Database,
  input: {
    readonly groupId: string;
    readonly userId: string;
    readonly chatId: number;
    readonly state: SplitState;
    readonly now: Date;
  },
): Promise<SplitFlow> {
  return db.transaction(async (tx) => {
    await tx
      .delete(s.telegramSplitFlows)
      .where(lt(s.telegramSplitFlows.expiresAt, new Date(input.now.getTime() - EXPIRED_KEEP_MS)));
    await tx
      .delete(s.telegramSplitFlows)
      .where(
        and(
          eq(s.telegramSplitFlows.groupId, input.groupId),
          eq(s.telegramSplitFlows.userId, input.userId),
        ),
      );
    const [row] = await tx
      .insert(s.telegramSplitFlows)
      .values({
        groupId: input.groupId,
        userId: input.userId,
        chatId: input.chatId,
        step: "title",
        state: input.state,
        expiresAt: new Date(input.now.getTime() + SPLIT_FLOW_TTL_MS),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    const flow = row ? toFlow(row) : null;
    if (!flow) throw new Error("could not start the split flow");
    return flow;
  });
}

export interface FlowChange {
  readonly step?: SplitStep;
  readonly state?: SplitState;
  readonly messageId?: number;
}

/**
 * Saves a change if nobody else changed the flow since it was read, and keeps it alive for another
 * `SPLIT_FLOW_TTL_MS`. Returns the new version, or null when the flow moved on (or is gone).
 */
export async function saveFlow(
  db: Database,
  flow: SplitFlow,
  change: FlowChange,
  now: Date,
): Promise<number | null> {
  const rows = await db
    .update(s.telegramSplitFlows)
    .set({
      ...(change.step === undefined ? {} : { step: change.step }),
      ...(change.state === undefined ? {} : { state: change.state }),
      ...(change.messageId === undefined ? {} : { messageId: change.messageId }),
      version: sql`${s.telegramSplitFlows.version} + 1`,
      expiresAt: new Date(now.getTime() + SPLIT_FLOW_TTL_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(s.telegramSplitFlows.id, flow.id),
        eq(s.telegramSplitFlows.version, flow.version),
        gt(s.telegramSplitFlows.expiresAt, now),
      ),
    )
    .returning({ version: s.telegramSplitFlows.version });
  return rows[0]?.version ?? null;
}

/**
 * Takes the Confirm tap: true for exactly one caller. The flow then reads `confirming` until the
 * expense is saved (`deleteFlow`) or the attempt is given up (`releaseConfirm`).
 */
export async function claimConfirm(db: Database, flow: SplitFlow, now: Date): Promise<boolean> {
  const rows = await db
    .update(s.telegramSplitFlows)
    .set({ step: CONFIRMING, version: sql`${s.telegramSplitFlows.version} + 1`, updatedAt: now })
    .where(
      and(
        eq(s.telegramSplitFlows.id, flow.id),
        eq(s.telegramSplitFlows.version, flow.version),
        eq(s.telegramSplitFlows.step, "summary"),
      ),
    )
    .returning({ id: s.telegramSplitFlows.id });
  return rows.length > 0;
}

export async function releaseConfirm(db: Database, flowId: string, now: Date): Promise<void> {
  await db
    .update(s.telegramSplitFlows)
    .set({ step: "summary", version: sql`${s.telegramSplitFlows.version} + 1`, updatedAt: now })
    .where(and(eq(s.telegramSplitFlows.id, flowId), eq(s.telegramSplitFlows.step, CONFIRMING)));
}

export async function deleteFlow(db: Database, flowId: string): Promise<void> {
  await db.delete(s.telegramSplitFlows).where(eq(s.telegramSplitFlows.id, flowId));
}

/** Removes the member's flow, open or expired; whether there was one. */
export async function deleteMemberFlow(
  db: Database,
  who: { readonly groupId: string; readonly userId: string },
): Promise<boolean> {
  const rows = await db
    .delete(s.telegramSplitFlows)
    .where(
      and(
        eq(s.telegramSplitFlows.groupId, who.groupId),
        eq(s.telegramSplitFlows.userId, who.userId),
      ),
    )
    .returning({ id: s.telegramSplitFlows.id });
  return rows.length > 0;
}

/** The group's time zone, for "today" and "yesterday"; UTC if the stored name is not a zone. */
export async function groupTimeZone(db: Database, groupId: string): Promise<string> {
  const [row] = await db
    .select({ timeZone: s.groups.timeZone })
    .from(s.groups)
    .where(eq(s.groups.id, groupId));
  const zone = row?.timeZone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
