import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/lib/import/policy";

/**
 * The web upload route is the production path for the size cap: it must refuse an oversize body
 * before reading it and an oversize file before storing it or paying for a model call.
 */

const uploadScreenshot = vi.fn();
vi.mock("@/server/import/service", () => ({
  uploadScreenshot: (...args: unknown[]) => uploadScreenshot(...args) as unknown,
}));
vi.mock("@/server/import/runtime", () => ({
  openImportDeps: () => Promise.resolve({ dailyLimit: 30, groupId: "g" }),
}));

const { POST } = await import("./route");

function upload(bytes: number, headers: Record<string, string> = {}): Request {
  const body = new FormData();
  body.set("file", new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
  return new Request("https://lullet.test/api/imports", { method: "POST", body, headers });
}

beforeEach(() => {
  uploadScreenshot.mockReset();
  uploadScreenshot.mockResolvedValue({ importId: "i1", empty: false });
});

describe("POST /api/imports caps", () => {
  it("refuses a body that declares more than the cap without reading it", async () => {
    const response = await POST(upload(10, { "content-length": String(MAX_UPLOAD_BYTES * 2) }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid" });
    expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it("refuses a file larger than the cap", async () => {
    const response = await POST(upload(MAX_UPLOAD_BYTES + 1));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("4 MB");
    expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it("refuses a request with no file", async () => {
    const response = await POST(
      new Request("https://lullet.test/api/imports", { method: "POST", body: new FormData() }),
    );
    expect(response.status).toBe(422);
    expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it("passes a file at the cap on to the import service", async () => {
    const response = await POST(upload(MAX_UPLOAD_BYTES));
    expect(response.status).toBe(201);
    expect(uploadScreenshot).toHaveBeenCalledOnce();
  });

  it("answers a daily-limit refusal with 429", async () => {
    const { UploadLimitError } = await import("@/server/import/errors");
    uploadScreenshot.mockRejectedValue(new UploadLimitError(30));
    const response = await POST(upload(1000));
    expect(response.status).toBe(429);
  });
});
