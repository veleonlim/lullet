import type { Metadata } from "next";
import { listMembers } from "@/lib/auth/db/members";
import { requireSession } from "@/lib/auth/session";
import { RebindForm } from "./rebind-form";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage() {
  const session = await requireSession();
  const members = await listMembers(session.groupId);
  const viewerIsOwner = members.some((m) => m.userId === session.userId && m.isOwner);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Members</h1>
        <p className="max-w-prose text-base text-pretty text-muted">
          Only these Telegram accounts can open lullet.
          {viewerIsOwner
            ? " If someone loses their Telegram account, point them at a new one here."
            : " The group owner can re-bind a member whose Telegram account changed."}
        </p>
      </section>

      <ul className="space-y-3">
        {members.map((member) => (
          <li
            key={member.userId}
            data-testid="member"
            className="rounded-xl border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="font-medium">
                {member.displayName}
                {member.isOwner ? (
                  <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                    Owner
                  </span>
                ) : null}
              </p>
              <p className="font-mono text-sm text-muted">
                {member.telegramUserId ?? "not linked"}
                {member.telegramUsername ? ` (@${member.telegramUsername})` : ""}
              </p>
            </div>
            {viewerIsOwner ? <RebindForm userId={member.userId} name={member.displayName} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
