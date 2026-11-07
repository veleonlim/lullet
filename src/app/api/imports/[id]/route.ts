import { draftEditSchema } from "@/lib/import";
import { ImportError } from "@/server/import/errors";
import { json, readJson, withImports } from "@/server/import/http";

export const dynamic = "force-dynamic";

/** Save the edits made on the review screen to an open draft (uploader only). */
export function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async ({ store }) => {
    const { id } = await context.params;
    const edit = draftEditSchema.safeParse(await readJson(request));
    if (!edit.success) throw new ImportError("invalid", "The edits were not understood");
    return json(await store.saveDraft(id, edit.data));
  });
}
