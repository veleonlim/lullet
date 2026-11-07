import { MAX_UPLOAD_BYTES } from "@/lib/import/policy";
import { ImportError } from "@/server/import/errors";
import { json, withImports } from "@/server/import/http";
import { uploadScreenshot } from "@/server/import/service";

export const dynamic = "force-dynamic";
// Reading the screenshot with the model takes a few seconds.
export const maxDuration = 60;

/** Multipart body overhead allowed on top of the file itself. */
const BODY_SLACK = 64_000;

/** Upload a screenshot: stored privately, read by the model, left as a draft to review. */
export function POST(request: Request) {
  return withImports(request, { write: true }, async (deps) => {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES + BODY_SLACK) {
      throw new ImportError("invalid", "That file is too large. The limit is 4 MB");
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new ImportError("invalid", "Choose a screenshot to upload");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ImportError("invalid", "That file is too large. The limit is 4 MB");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await uploadScreenshot(deps, { bytes, source: "web" });
    return json({ id: result.importId, empty: result.empty }, 201);
  });
}
