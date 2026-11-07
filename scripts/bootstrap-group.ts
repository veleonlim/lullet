/**
 * Creates the group and its members, linking each to a Telegram account. This fills the allowlist
 * the first time; after that the owner re-binds members from the Members page.
 *
 *   pnpm auth:bootstrap --group "Switzerland and Italy" \
 *     --member "Veleon=123456789" --member "Mei=234567890" ...
 *
 * The first --member becomes the owner and the order given is the group's fixed member order
 * (it decides who gets the spare cent), so choose it once. Guarded: refuses to run when a group
 * already exists, so a second run cannot create a parallel group by accident.
 */
import { parseArgs } from "node:util";
import { getDatabase } from "@/db/client";
import { groups } from "@/db/schema";
import { bootstrapGroup } from "@/lib/auth/db/members";
import { getSessionSecret } from "@/lib/auth/config";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      group: { type: "string" },
      member: { type: "string", multiple: true },
    },
  });
  const members = (values.member ?? []).map((entry) => {
    const separator = entry.lastIndexOf("=");
    const displayName = entry.slice(0, separator).trim();
    const id = entry.slice(separator + 1).trim();
    if (separator < 1 || !displayName || !/^\d{1,15}$/.test(id)) {
      throw new Error(`Bad --member "${entry}". Use "Name=telegram-user-id" (digits only).`);
    }
    return { displayName, telegramUserId: Number(id) };
  });
  if (!values.group || members.length === 0) {
    console.error('Usage: pnpm auth:bootstrap --group "Name" --member "Name=telegram-user-id" ...');
    return 1;
  }

  const { db } = getDatabase();
  const existing = await db.select({ id: groups.id }).from(groups).limit(1);
  if (existing.length > 0) {
    console.error("A group already exists. Refusing to create another one.");
    return 2;
  }
  getSessionSecret(); // fail early if the app could not run with this environment
  const result = await bootstrapGroup({ groupName: values.group, members });
  console.log(
    `Created group ${result.groupId} with ${members.length} members; ${members[0]?.displayName} is the owner.`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await getDatabase().pool.end();
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
