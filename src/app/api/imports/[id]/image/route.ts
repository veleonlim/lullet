import { ImportNotFoundError } from "@/server/import/errors";
import { withImports } from "@/server/import/http";

export const dynamic = "force-dynamic";

/**
 * The original screenshot, served by the app itself to signed-in members of the group. The
 * storage is private and no signed or public link is ever handed out.
 */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: false }, async ({ store, storage }) => {
    const { id } = await context.params;
    const info = await store.imageInfo(id);
    if (!info) throw new ImportNotFoundError();
    const stored = await storage.get(info.storageKey);
    if (!stored) throw new ImportNotFoundError();
    return new Response(stored.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": info.mediaType,
        "Content-Length": String(stored.bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
}
