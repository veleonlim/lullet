"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { rebindMember, type RebindFailure } from "@/lib/auth/db/members";
import { getSessionId, requireSession } from "@/lib/auth/session";

export type RebindState =
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const messages: Record<RebindFailure, string> = {
  not_owner: "Only the group owner can re-bind a member.",
  not_a_member: "That person is not in this group.",
  invalid_telegram_id: "Enter the Telegram user id as digits only.",
  telegram_id_in_use: "That Telegram account is already linked to someone else.",
};

const inputSchema = z.object({
  userId: z.uuid(),
  telegramUserId: z
    .string()
    .trim()
    .regex(/^\d{1,15}$/),
});

/**
 * Re-links a member to a new Telegram account (for example after they lose theirs). The caller
 * comes from the session, and the owner check is made in the database transaction itself, so
 * a forged form from anyone else is refused.
 */
export async function rebindMemberAction(
  _previous: RebindState,
  formData: FormData,
): Promise<RebindState> {
  const session = await requireSession();
  const input = inputSchema.safeParse({
    userId: formData.get("userId"),
    telegramUserId: formData.get("telegramUserId"),
  });
  if (!input.success) return { status: "error", message: messages.invalid_telegram_id };

  const sessionId = await getSessionId();
  const result = await rebindMember({
    actor: session,
    targetUserId: input.data.userId,
    telegramUserId: Number(input.data.telegramUserId),
    ...(sessionId ? { keepSessionId: sessionId } : {}),
  });
  if (!result.ok) return { status: "error", message: messages[result.reason] };

  revalidatePath("/members");
  return {
    status: "done",
    message: "Re-bound. Their old sign-ins were signed out; they can sign in with the new account.",
  };
}
