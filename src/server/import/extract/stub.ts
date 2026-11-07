import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractionSchema } from "@/lib/import/extraction";
import { sha256Hex } from "@/lib/import/image";
import { z } from "zod";
import { EXTRACTION_FAILURES } from "@/lib/import/failure";
import {
  EXTRACTION_MODELS,
  type ExtractionOutcome,
  type ExtractionRequest,
  type ImageExtractor,
} from "./types";

const failureFile = z.object({ failure: z.enum(EXTRACTION_FAILURES) });

/**
 * A model stand-in for end to end tests. It never calls the network: for an image whose SHA-256
 * is `<sha>` it answers with the contents of `<dir>/<sha>.json` (or `<sha>.reread.json` for the
 * stronger re-read), falling back to `<dir>/default.json`. A file is either an extraction or
 * `{ "failure": "refused" }` and the like. Selected with `LULLET_EXTRACTOR=stub`.
 */
export class StubExtractor implements ImageExtractor {
  constructor(private readonly directory: string) {}

  private async load(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
    const model = request.model;
    const sha = await sha256Hex(request.bytes);
    const names =
      model === EXTRACTION_MODELS.reread
        ? [`${sha}.reread.json`, `${sha}.json`, "default.json"]
        : [`${sha}.json`, "default.json"];
    for (const name of names) {
      const content = await this.load(name);
      if (content === undefined) continue;
      const failure = failureFile.safeParse(content);
      if (failure.success) return { ok: false, model, failure: failure.data.failure };
      const parsed = extractionSchema.safeParse(content);
      return parsed.success
        ? { ok: true, model, extraction: parsed.data }
        : { ok: false, model, failure: "malformed" };
    }
    return { ok: false, model, failure: "malformed" };
  }
}
