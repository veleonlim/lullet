import type { ConfirmResult, DraftEdit, DraftView } from "@/lib/import";

/** What the import routes answer when something is wrong. */
export interface ApiProblem {
  readonly error: string;
  readonly message: string;
  readonly existingImportId?: string;
  readonly rowErrors?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ApiProblem,
  ) {
    super(problem.message);
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, {
      error: "network",
      message: "Could not reach the server. Check your connection.",
    });
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const problem =
      body && typeof body === "object" && "message" in body
        ? (body as ApiProblem)
        : { error: "unknown", message: "Something went wrong. Try again." };
    throw new ApiError(response.status, problem);
  }
  return body as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function uploadScreenshotRequest(
  file: Blob,
  name: string,
): Promise<{ id: string; empty: boolean }> {
  const form = new FormData();
  form.set("file", file, name);
  return call("/api/imports", { method: "POST", body: form });
}

export function saveDraftRequest(id: string, edit: DraftEdit): Promise<DraftView> {
  return call(`/api/imports/${id}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(edit),
  });
}

export function addRowRequest(id: string): Promise<DraftView> {
  return call(`/api/imports/${id}/rows`, { method: "POST" });
}

export function confirmRequest(id: string, edit: DraftEdit): Promise<ConfirmResult> {
  return call(`/api/imports/${id}/confirm`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(edit),
  });
}

export function cancelRequest(id: string): Promise<{ ok: true }> {
  return call(`/api/imports/${id}/cancel`, { method: "POST" });
}

export function rereadRequest(id: string): Promise<{ view: DraftView; failed: boolean }> {
  return call(`/api/imports/${id}/reread`, { method: "POST" });
}

export function undoRequest(id: string): Promise<{ expenseIds: string[] }> {
  return call(`/api/imports/${id}/undo`, { method: "POST" });
}
