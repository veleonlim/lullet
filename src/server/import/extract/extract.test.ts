import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/import/normalize";
import { sha256Hex } from "@/lib/import/image";
import { wireframeExtraction } from "@/test-support/extraction";
import {
  AMBIGUOUS_RESPONSE,
  CLEAN_RESPONSE,
  FOREIGN_WITH_UNLABELED_BILLED_RESPONSE,
  INJECTION_RESPONSE,
  MALFORMED_RESPONSE,
  MAX_TOKENS_RESPONSE,
  REFUSED_RESPONSE,
  WRONG_SHAPE_RESPONSE,
} from "@/test-support/claude-responses";
import { makePng } from "@/test-support/images";
import {
  AnthropicExtractor,
  createExtractorFromEnv,
  EXTRACTION_MODELS,
  MAX_OUTPUT_TOKENS,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
  StubExtractor,
  type ExtractionRequest,
  type MessagesClient,
} from ".";

const PNG = makePng({ seed: 11 });
const request = (overrides: Partial<ExtractionRequest> = {}): ExtractionRequest => ({
  bytes: PNG,
  mediaType: "image/png",
  model: EXTRACTION_MODELS.default,
  today: "2026-11-08",
  ...overrides,
});

/** A client that records the request and answers with a canned response (or fails). */
function fakeClient(answer: Anthropic.Message | Error) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create(params) {
        calls.push(params);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
  return { client, calls };
}

describe("the request sent to Claude", () => {
  it("is one image plus a short prompt, with a schema-constrained answer and no tools", async () => {
    const { client, calls } = fakeClient(CLEAN_RESPONSE);
    await new AnthropicExtractor(client).extract(request());
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.model).toBe("claude-haiku-5-5");
    expect(call?.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(call?.tools).toBeUndefined();
    expect(call?.tool_choice).toBeUndefined();
    expect(call?.output_config?.format?.type).toBe("json_schema");
    expect(call?.output_config?.effort).toBe("low");
    expect(typeof call?.system).toBe("string");
    const content = call?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected content blocks");
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    const image = content[0];
    if (image?.type !== "image" || image.source.type !== "base64")
      throw new Error("expected base64 image");
    expect(image.source.media_type).toBe("image/png");
    expect(Buffer.from(image.source.data, "base64").equals(Buffer.from(PNG))).toBe(true);
  });

  it("uses Sonnet 5.5 for the re-read", async () => {
    const { client, calls } = fakeClient(CLEAN_RESPONSE);
    await new AnthropicExtractor(client).extract(request({ model: EXTRACTION_MODELS.reread }));
    expect(calls[0]?.model).toBe("claude-sonnet-5-5");
    expect(calls[0]?.output_config?.effort).toBe("medium");
  });
});

describe("what comes back", () => {
  it("reads a clean answer into the four wireframe rows", async () => {
    const outcome = await new AnthropicExtractor(fakeClient(CLEAN_RESPONSE).client).extract(
      request(),
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.model).toBe("claude-haiku-5-5");
    const rows = normalizeExtraction(outcome.extraction, "2026-11-08").rows;
    expect(rows.map((r) => [r.merchant, r.amountMinor, r.category])).toEqual([
      ["Trattoria Roma", 4850, "food"],
      ["Metro Roma", 1200, "transport"],
      ["AMZN Mktp", 2399, "shopping"],
      ["Louvre", 6400, "sightseeing"],
    ]);
  });

  it("reads EUR 100 beside an unlabeled 144.26 as 100 EUR billed 144.26 SGD", async () => {
    const outcome = await new AnthropicExtractor(
      fakeClient(FOREIGN_WITH_UNLABELED_BILLED_RESPONSE).client,
    ).extract(request());
    if (!outcome.ok) throw new Error("expected ok");
    const [row] = normalizeExtraction(outcome.extraction, "2026-11-08").rows;
    expect(row).toMatchObject({
      merchant: "Trenitalia - Lefrecce Roma Rmit",
      amountMinor: 10000,
      currency: "EUR",
      billedAmountMinor: 14426,
      billedCurrency: "SGD",
      included: true,
      issues: [],
    });
  });

  it("flags the doubts in an ambiguous answer instead of fixing them", async () => {
    const outcome = await new AnthropicExtractor(fakeClient(AMBIGUOUS_RESPONSE).client).extract(
      request(),
    );
    if (!outcome.ok) throw new Error("expected ok");
    const [disagrees, noDate, noCurrency] = normalizeExtraction(
      outcome.extraction,
      "2026-11-08",
    ).rows;
    expect(disagrees?.issues).toContain("amount_disagrees");
    expect(disagrees?.included).toBe(true);
    expect(noDate?.fieldStates.date).toBe("unreadable");
    expect(noDate?.included).toBe(false);
    expect(noCurrency?.currency).toBeNull();
    expect(noCurrency?.category).toBe("other");
    expect(noCurrency?.included).toBe(false);
  });

  it("keeps instructions found in a screenshot as plain text in a field", async () => {
    const outcome = await new AnthropicExtractor(fakeClient(INJECTION_RESPONSE).client).extract(
      request(),
    );
    if (!outcome.ok) throw new Error("expected ok");
    const [row] = normalizeExtraction(outcome.extraction, "2026-11-08").rows;
    expect(row?.merchant).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    // The amount is still the one read from the amount text, not anything the text asked for.
    expect(row?.amountMinor).toBe(4850);
    expect(row?.fieldStates.merchant).toBe("uncertain");
  });
});

describe("the time budget", () => {
  // Vercel Hobby with Fluid compute: default and maximum function duration, in seconds.
  const PLAN_MAX_DURATION_S = 300;
  const routes = {
    uploads: () => import("@/app/api/imports/route"),
    "re-reads": () => import("@/app/api/imports/[id]/reread/route"),
    "the Telegram webhook": () => import("@/app/api/telegram/webhook/route"),
  };
  for (const [name, load] of Object.entries(routes)) {
    it(`gives ${name} time to record a failed read, within the plan limit`, async () => {
      const { maxDuration } = await load();
      const worstCaseS = (REQUEST_TIMEOUT_MS * (MAX_RETRIES + 1)) / 1000;
      expect(maxDuration - worstCaseS).toBeGreaterThanOrEqual(30);
      expect(maxDuration).toBeLessThanOrEqual(PLAN_MAX_DURATION_S);
    });
  }
});

describe("failures become an empty draft, never a partial import", () => {
  const cases = [
    ["a refusal", REFUSED_RESPONSE, "refused"],
    ["a cut-off answer", MAX_TOKENS_RESPONSE, "max_tokens"],
    ["chatty text", MALFORMED_RESPONSE, "malformed"],
    ["JSON of the wrong shape", WRONG_SHAPE_RESPONSE, "malformed"],
  ] as const;
  for (const [name, response, failure] of cases) {
    it(`reports ${name} as ${failure}`, async () => {
      const outcome = await new AnthropicExtractor(fakeClient(response).client).extract(request());
      expect(outcome).toEqual({ ok: false, model: "claude-haiku-5-5", failure });
    });
  }

  it("reports a service error as api_error without leaking its message", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const error = new Anthropic.APIError(
        500,
        { error: { message: "secret detail" } },
        "secret detail",
        new Headers(),
      );
      const outcome = await new AnthropicExtractor(fakeClient(error).client).extract(request());
      expect(outcome).toEqual({ ok: false, model: "claude-haiku-5-5", failure: "api_error" });
      expect(JSON.stringify(logged)).not.toContain("secret detail");
      const other = await new AnthropicExtractor(
        fakeClient(new Error("socket hang up")).client,
      ).extract(request());
      expect(other).toMatchObject({ failure: "api_error" });
    } finally {
      console.error = original;
    }
  });

  it("reports a missing API key", async () => {
    const outcome = await new AnthropicExtractor(undefined, {}).extract(request());
    expect(outcome).toEqual({ ok: false, model: "claude-haiku-5-5", failure: "not_configured" });
  });

  it("builds the real client when a key is present", () => {
    // No request is made: the client is only constructed, then reused.
    const extractor = new AnthropicExtractor(undefined, { ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(createExtractorFromEnv({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBeInstanceOf(
      AnthropicExtractor,
    );
    expect(extractor).toBeInstanceOf(AnthropicExtractor);
  });
});

describe("the stub used by the end to end tests", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "lullet-stub-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("answers by image hash, with a stronger answer for the re-read and a default", async () => {
    const sha = await sha256Hex(PNG);
    const stub = new StubExtractor(directory);
    expect(await stub.extract(request())).toMatchObject({ ok: false, failure: "malformed" });

    await writeFile(path.join(directory, "default.json"), JSON.stringify(wireframeExtraction()));
    const fallback = await stub.extract(request());
    expect(fallback.ok && fallback.extraction.transactions).toHaveLength(4);

    await writeFile(
      path.join(directory, `${sha}.json`),
      JSON.stringify({ ...wireframeExtraction(), transactions: [] }),
    );
    const specific = await stub.extract(request());
    expect(specific.ok && specific.extraction.transactions).toHaveLength(0);

    await writeFile(
      path.join(directory, `${sha}.reread.json`),
      JSON.stringify(wireframeExtraction()),
    );
    const reread = await stub.extract(request({ model: EXTRACTION_MODELS.reread }));
    expect(reread).toMatchObject({ ok: true, model: "claude-sonnet-5-5" });

    await writeFile(path.join(directory, `${sha}.json`), JSON.stringify({ failure: "refused" }));
    expect(await stub.extract(request())).toMatchObject({ ok: false, failure: "refused" });

    await writeFile(path.join(directory, `${sha}.json`), JSON.stringify({ nonsense: true }));
    expect(await stub.extract(request())).toMatchObject({ ok: false, failure: "malformed" });
  });

  it("is chosen only by LULLET_EXTRACTOR=stub", () => {
    expect(
      createExtractorFromEnv({ LULLET_EXTRACTOR: "stub", LULLET_STUB_DIR: directory }),
    ).toBeInstanceOf(StubExtractor);
    expect(createExtractorFromEnv({ LULLET_EXTRACTOR: "stub" })).toBeInstanceOf(StubExtractor);
    expect(createExtractorFromEnv({})).toBeInstanceOf(AnthropicExtractor);
  });
});
