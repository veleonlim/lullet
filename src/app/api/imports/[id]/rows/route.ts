import { json, withImports } from "@/server/import/http";

export const dynamic = "force-dynamic";

/** Add a blank row to type a transaction in by hand (uploader only). */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async ({ store }) => {
    const { id } = await context.params;
    return json(await store.addRow(id), 201);
  });
}
