import { json, withImports } from "@/server/import/http";

export const dynamic = "force-dynamic";

/** Reverse a confirmed import: its expenses are soft deleted together (uploader only). */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async ({ store }) => {
    const { id } = await context.params;
    return json(await store.undo(id));
  });
}
