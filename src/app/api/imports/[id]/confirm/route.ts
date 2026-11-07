import { draftEditSchema } from "@/lib/import";
import { ImportError } from "@/server/import/errors";
import { json, readJson, withImports } from "@/server/import/http";

export const dynamic = "force-dynamic";
// Fetching exchange rates for the day of each expense happens before the rows are added.
export const maxDuration = 30;

/**
 * Add the ticked rows to the ledger, all in one transaction (uploader only). Confirming an import
 * that was already added changes nothing and answers with what it added.
 */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async ({ store }) => {
    const { id } = await context.params;
    const edit = draftEditSchema.safeParse(await readJson(request));
    if (!edit.success) throw new ImportError("invalid", "The edits were not understood");
    return json(await store.confirm(id, edit.data));
  });
}
