import { draftEditSchema } from "@/lib/import";
import { ImportError } from "@/server/import/errors";
import { json, readJson, withImports } from "@/server/import/http";
import { confirmImport } from "@/server/import/service";
import { notifyAfterResponse } from "@/server/telegram/runtime";

export const dynamic = "force-dynamic";
// Fetching exchange rates for the day of each expense happens before the rows are added.
export const maxDuration = 30;

/**
 * Add the ticked rows to the ledger, all in one transaction (uploader only). Confirming an import
 * that was already added changes nothing and answers with what it added. The original screenshot
 * is deleted once the rows are in.
 */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async (deps) => {
    const { store } = deps;
    const { id } = await context.params;
    const edit = draftEditSchema.safeParse(await readJson(request));
    if (!edit.success) throw new ImportError("invalid", "The edits were not understood");
    const result = await confirmImport(deps, id, edit.data);
    if (result.added) {
      const { userId, groupId } = store.session;
      const view = await store.getDraft(id);
      // Tell the group what was added (once: a repeated confirm adds nothing and says nothing).
      if (view) notifyAfterResponse((bot) => bot.importConfirmed(groupId, userId, view.expenses));
    }
    return json(result);
  });
}
