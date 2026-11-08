import { json, withImports } from "@/server/import/http";
import { rereadScreenshot } from "@/server/import/service";

export const dynamic = "force-dynamic";
// Same budget as the upload route: two model attempts of up to 60 s each.
export const maxDuration = 180;

/** Read the screenshot again with the stronger model, replacing the rows (uploader only). */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async (deps) => {
    const { id } = await context.params;
    const { view, failed } = await rereadScreenshot(deps, id);
    return json({ view, failed });
  });
}
