import { json, withImports } from "@/server/import/http";
import { rereadScreenshot } from "@/server/import/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Read the screenshot again with the stronger model, replacing the rows (uploader only). */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async (deps) => {
    const { id } = await context.params;
    const { view, failed } = await rereadScreenshot(deps, id);
    return json({ view, failed });
  });
}
