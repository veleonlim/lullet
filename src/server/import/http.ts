import { isSameOrigin } from "@/lib/auth/same-origin";
import { LedgerError } from "@/server/ledger";
import {
  DraftInvalidError,
  DuplicateImageError,
  ImportError,
  type ImportErrorCode,
} from "./errors";
import { openImportDeps } from "./runtime";
import type { ImportDeps } from "./service";

const STATUS: Readonly<Record<ImportErrorCode, number>> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  expired: 410,
  limit: 429,
  duplicate_image: 409,
  invalid: 422,
  unavailable: 410,
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Maps the failures of the import layer to responses a client can act on. */
export function errorResponse(error: unknown): Response {
  if (error instanceof DraftInvalidError) {
    return json({ error: error.code, message: error.message, rowErrors: error.errors }, 422);
  }
  if (error instanceof DuplicateImageError) {
    return json(
      { error: error.code, message: error.message, existingImportId: error.existingImportId },
      409,
    );
  }
  if (error instanceof ImportError) {
    return json({ error: error.code, message: error.message }, STATUS[error.code]);
  }
  if (error instanceof LedgerError) {
    return json(
      { error: error.code, message: error.message },
      error.code === "not_a_member" ? 403 : 409,
    );
  }
  // Only the kind of failure is logged: messages could echo what was uploaded.
  console.error("Import request failed", error instanceof Error ? error.name : "unexpected error");
  return json({ error: "server_error", message: "Something went wrong. Try again." }, 500);
}

/**
 * Runs a handler for a signed-in member. Writes refuse requests that a browser reports as coming
 * from another site; everyone else gets a 401 and never reaches the data layer.
 */
export async function withImports(
  request: Request,
  options: { readonly write: boolean },
  handler: (deps: ImportDeps) => Promise<Response>,
): Promise<Response> {
  if (options.write && !isSameOrigin(request.headers)) {
    return json({ error: "forbidden", message: "Cross-site request refused" }, 403);
  }
  try {
    const deps = await openImportDeps();
    if (!deps) return json({ error: "unauthorized", message: "Sign in first" }, 401);
    return await handler(deps);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new ImportError("invalid", "The request was not understood");
  }
}
