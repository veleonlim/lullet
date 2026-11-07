import { and, asc, eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { resolveDeps, type AuthDeps } from "../deps";

/** The app identity behind a Telegram account, or null when that account is not on the allowlist. */
export interface Member {
  readonly userId: string;
  readonly groupId: string;
}

/**
 * The allowlist is the `telegram_links` table: a Telegram user id is served only if it is linked
 * to a member of a group. A user in several groups gets the one they joined first.
 */
export async function findMemberByTelegramId(
  telegramUserId: number,
  deps?: AuthDeps,
): Promise<Member | null> {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return null;
  const { db } = resolveDeps(deps);
  const [row] = await db
    .select({ userId: s.telegramLinks.userId, groupId: s.memberships.groupId })
    .from(s.telegramLinks)
    .innerJoin(s.memberships, eq(s.memberships.userId, s.telegramLinks.userId))
    .where(eq(s.telegramLinks.telegramUserId, telegramUserId))
    .orderBy(asc(s.memberships.createdAt))
    .limit(1);
  return row ?? null;
}

/** Same lookup by app user (used when a login link is redeemed). */
export async function findMemberByUserId(userId: string, deps?: AuthDeps): Promise<Member | null> {
  const { db } = resolveDeps(deps);
  const [row] = await db
    .select({ userId: s.telegramLinks.userId, groupId: s.memberships.groupId })
    .from(s.telegramLinks)
    .innerJoin(s.memberships, eq(s.memberships.userId, s.telegramLinks.userId))
    .where(eq(s.telegramLinks.userId, userId))
    .orderBy(asc(s.memberships.createdAt))
    .limit(1);
  return row ?? null;
}

export interface MemberRow {
  readonly userId: string;
  readonly displayName: string;
  readonly position: number;
  readonly isOwner: boolean;
  readonly telegramUserId: number | null;
  readonly telegramUsername: string | null;
}

/** The members of a group in their fixed order, with their Telegram link if any. */
export async function listMembers(groupId: string, deps?: AuthDeps): Promise<MemberRow[]> {
  const { db } = resolveDeps(deps);
  return db
    .select({
      userId: s.users.id,
      displayName: s.users.displayName,
      position: s.memberships.position,
      isOwner: s.memberships.isOwner,
      telegramUserId: s.telegramLinks.telegramUserId,
      telegramUsername: s.telegramLinks.username,
    })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .leftJoin(s.telegramLinks, eq(s.telegramLinks.userId, s.memberships.userId))
    .where(eq(s.memberships.groupId, groupId))
    .orderBy(asc(s.memberships.position));
}

export interface CurrentUser {
  readonly userId: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly isOwner: boolean;
}

export async function getCurrentUser(member: Member, deps?: AuthDeps): Promise<CurrentUser | null> {
  const { db } = resolveDeps(deps);
  const [row] = await db
    .select({ displayName: s.users.displayName, isOwner: s.memberships.isOwner })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .where(and(eq(s.memberships.groupId, member.groupId), eq(s.memberships.userId, member.userId)));
  return row ? { ...member, ...row } : null;
}

export interface BootstrapMember {
  readonly displayName: string;
  readonly telegramUserId: number;
}

/**
 * Creates a group with its members, in the given order, linked to their Telegram accounts. The
 * first member becomes the owner. This is how the allowlist is first filled in (see the README).
 */
export async function bootstrapGroup(
  input: { readonly groupName: string; readonly members: readonly BootstrapMember[] },
  deps?: AuthDeps,
): Promise<{ groupId: string; userIds: string[] }> {
  const { db } = resolveDeps(deps);
  if (input.members.length === 0) throw new Error("A group needs at least one member.");
  for (const member of input.members) {
    if (!Number.isSafeInteger(member.telegramUserId) || member.telegramUserId <= 0) {
      throw new Error(`Invalid Telegram user id for ${member.displayName}.`);
    }
  }
  return db.transaction(async (tx) => {
    const [group] = await tx.insert(s.groups).values({ name: input.groupName }).returning();
    if (!group) throw new Error("group insert returned nothing");
    const userIds: string[] = [];
    for (const [position, member] of input.members.entries()) {
      const [user] = await tx
        .insert(s.users)
        .values({ displayName: member.displayName })
        .returning({ id: s.users.id });
      if (!user) throw new Error("user insert returned nothing");
      await tx.insert(s.memberships).values({
        groupId: group.id,
        userId: user.id,
        position,
        isOwner: position === 0,
      });
      await tx
        .insert(s.telegramLinks)
        .values({ userId: user.id, telegramUserId: member.telegramUserId });
      userIds.push(user.id);
    }
    return { groupId: group.id, userIds };
  });
}

export type RebindFailure =
  "not_owner" | "not_a_member" | "invalid_telegram_id" | "telegram_id_in_use";

export type RebindResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: RebindFailure };

/**
 * Points a member at a new Telegram account. Only the group's owner may do this. The member's
 * sessions and unused login links are revoked, because they belonged to the old account; the
 * caller's own current session survives when the owner re-binds themselves.
 */
export async function rebindMember(
  input: {
    readonly actor: Member;
    readonly targetUserId: string;
    readonly telegramUserId: number;
    readonly keepSessionId?: string;
  },
  deps?: AuthDeps,
): Promise<RebindResult> {
  const { db, now } = resolveDeps(deps);
  if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0) {
    return { ok: false, reason: "invalid_telegram_id" };
  }
  return db.transaction(async (tx): Promise<RebindResult> => {
    const memberships = await tx
      .select({ userId: s.memberships.userId, isOwner: s.memberships.isOwner })
      .from(s.memberships)
      .where(eq(s.memberships.groupId, input.actor.groupId))
      // Lock the rows so two concurrent re-binds cannot interleave.
      .for("update");
    const actor = memberships.find((m) => m.userId === input.actor.userId);
    if (!actor?.isOwner) return { ok: false, reason: "not_owner" };
    if (!memberships.some((m) => m.userId === input.targetUserId)) {
      return { ok: false, reason: "not_a_member" };
    }

    const [taken] = await tx
      .select({ userId: s.telegramLinks.userId })
      .from(s.telegramLinks)
      .where(eq(s.telegramLinks.telegramUserId, input.telegramUserId));
    if (taken && taken.userId !== input.targetUserId) {
      return { ok: false, reason: "telegram_id_in_use" };
    }

    const [previous] = await tx
      .select({ telegramUserId: s.telegramLinks.telegramUserId })
      .from(s.telegramLinks)
      .where(eq(s.telegramLinks.userId, input.targetUserId));

    await tx
      .insert(s.telegramLinks)
      .values({
        userId: input.targetUserId,
        telegramUserId: input.telegramUserId,
        linkedAt: now,
      })
      .onConflictDoUpdate({
        target: s.telegramLinks.userId,
        // The old chat id and username belong to the old account.
        set: {
          telegramUserId: input.telegramUserId,
          privateChatId: null,
          username: null,
          linkedAt: now,
        },
      });

    await tx
      .delete(s.sessions)
      .where(
        and(
          eq(s.sessions.userId, input.targetUserId),
          input.keepSessionId ? sql`${s.sessions.id} <> ${input.keepSessionId}` : undefined,
        ),
      );
    await tx
      .delete(s.loginTokens)
      .where(
        and(eq(s.loginTokens.userId, input.targetUserId), sql`${s.loginTokens.consumedAt} is null`),
      );

    await tx.insert(s.auditLog).values({
      groupId: input.actor.groupId,
      actorUserId: input.actor.userId,
      action: "member.telegram_rebound",
      entityType: "telegram_link",
      entityId: input.targetUserId,
      before: { telegramUserId: previous?.telegramUserId ?? null },
      after: { telegramUserId: input.telegramUserId },
    });
    return { ok: true };
  });
}
