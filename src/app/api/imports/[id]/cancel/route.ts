import { json, withImports } from "@/server/import/http";
import { cancelImport } from "@/server/import/service";

export const dynamic = "force-dynamic";

/** Discard an open draft and delete its original (uploader only). */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async (deps) => {
    const { id } = await context.params;
    await cancelImport(deps, id);
    return json({ ok: true });
  });
}
