import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRate } from "@/lib/money/rate";
import { FRANKFURTER_BASE_URL, FrankfurterClient, type FetchLike } from "./frankfurter";
import { FxRateError } from "./types";

/**
 * Responses recorded once from https://api.frankfurter.dev on 2026-11-07.
 * Tests replay them; nothing here (or in CI) calls the live service.
 */
const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/frankfurter");

interface Fixture {
  url: string;
  status: number;
  body: unknown;
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as Fixture;
}

/** A fetch that only answers the recorded URLs and fails on anything else. */
function replay(...names: string[]): { fetch: FetchLike; calls: string[] } {
  const known = new Map(names.map((name) => [fixture(name).url, fixture(name)] as const));
  const calls: string[] = [];
  const fetchImpl: FetchLike = (input) => {
    calls.push(input);
    const hit = known.get(input);
    if (!hit) throw new Error(`Unexpected request in a recorded-response test: ${input}`);
    return Promise.resolve(new Response(JSON.stringify(hit.body), { status: hit.status }));
  };
  return { fetch: fetchImpl, calls };
}

const respond =
  (body: unknown, status = 200): FetchLike =>
  () =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );

describe("FrankfurterClient with recorded responses", () => {
  it("covers every recorded fixture (no stale files)", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual([
      "chf-sgd-2026-11-02.json",
      "eur-sgd-2026-11-02.json",
      "eur-sgd-before-dataset-1990-01-01.json",
      "eur-sgd-weekend-2026-11-07.json",
    ]);
  });

  it("reads EUR to SGD for a business day", async () => {
    const { fetch, calls } = replay("eur-sgd-2026-11-02");
    const quote = await new FrankfurterClient({ fetch }).getRate("2026-11-02", "EUR", "SGD");
    expect(calls).toEqual(["https://api.frankfurter.dev/v1/2026-11-02?base=EUR&symbols=SGD"]);
    expect(quote).toMatchObject({
      provider: "frankfurter",
      base: "EUR",
      quote: "SGD",
      requestedDate: "2026-11-02",
      rateDate: "2026-11-02",
    });
    expect(formatRate(quote.rate)).toBe("1.4344");
  });

  it("covers CHF to SGD (the Swiss leg of the trip)", async () => {
    const { fetch } = replay("chf-sgd-2026-11-02");
    const quote = await new FrankfurterClient({ fetch }).getRate("2026-11-02", "CHF", "SGD");
    expect(formatRate(quote.rate)).toBe("1.5603");
  });

  it("reports the earlier rate date when asked for a weekend", async () => {
    const { fetch } = replay("eur-sgd-weekend-2026-11-07");
    const quote = await new FrankfurterClient({ fetch }).getRate("2026-11-07", "EUR", "SGD");
    expect(quote.requestedDate).toBe("2026-11-07");
    expect(quote.rateDate).toBe("2026-11-06");
    expect(formatRate(quote.rate)).toBe("1.4309");
  });

  it("maps a 404 to not_found", async () => {
    const { fetch } = replay("eur-sgd-before-dataset-1990-01-01");
    await expect(
      new FrankfurterClient({ fetch }).getRate("1990-01-01", "EUR", "SGD"),
    ).rejects.toMatchObject({
      name: "FxRateError",
      code: "not_found",
    });
  });

  it("does not call out for a currency against itself", async () => {
    const { fetch, calls } = replay();
    const quote = await new FrankfurterClient({ fetch }).getRate("2026-11-02", "SGD", "SGD");
    expect(formatRate(quote.rate)).toBe("1");
    expect(calls).toEqual([]);
  });

  it("validates the requested date before any request", async () => {
    const { fetch, calls } = replay();
    await expect(
      new FrankfurterClient({ fetch }).getRate("2026-02-30", "EUR", "SGD"),
    ).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

describe("FrankfurterClient failure handling", () => {
  const ask = (fetch: FetchLike, options: { timeoutMs?: number; baseUrl?: string } = {}) =>
    new FrankfurterClient({ fetch, ...options }).getRate("2026-11-02", "EUR", "SGD");
  const goodBody = { amount: 1, base: "EUR", date: "2026-11-02", rates: { SGD: 1.4344 } };

  it("turns server errors into http_error", async () => {
    await expect(ask(respond({ message: "boom" }, 500))).rejects.toMatchObject({
      code: "http_error",
    });
    await expect(ask(respond({}, 429))).rejects.toMatchObject({ code: "http_error" });
  });

  it("turns transport failures into network_error", async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    await expect(ask(failing)).rejects.toMatchObject({ code: "network_error" });
  });

  it("times out a request that never answers", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    await expect(ask(hanging, { timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
  });

  it.each([
    ["a non JSON body", "<html>oops</html>"],
    ["a missing rates object", { base: "EUR", date: "2026-11-02" }],
    ["the wrong base", { ...goodBody, base: "CHF" }],
    ["a missing quote", { ...goodBody, rates: { CHF: 0.9 } }],
    ["a malformed rate date", { ...goodBody, date: "11/02/2026" }],
    ["a rate dated after the request", { ...goodBody, date: "2026-11-03" }],
    ["a zero rate", { ...goodBody, rates: { SGD: 0 } }],
    ["a negative rate", { ...goodBody, rates: { SGD: -1.4 } }],
    ["a string rate", { ...goodBody, rates: { SGD: "1.4344" } }],
  ])("rejects %s as invalid_response", async (_label, body) => {
    await expect(ask(respond(body))).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("keeps the underlying cause for diagnosis", async () => {
    const cause = new TypeError("fetch failed");
    const error = await ask(() => Promise.reject(cause)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FxRateError);
    expect((error as FxRateError).cause).toBe(cause);
  });

  it("accepts a rate like 1e-7 expressed in scientific notation by the JSON parser", async () => {
    const quote = await ask(respond('{"base":"EUR","date":"2026-11-02","rates":{"SGD":1e-7}}'));
    expect(formatRate(quote.rate)).toBe("0.0000001");
  });

  it("honours a custom base URL and trims trailing slashes", async () => {
    const seen: string[] = [];
    const capture: FetchLike = (input) => {
      seen.push(input);
      return Promise.resolve(new Response(JSON.stringify(goodBody)));
    };
    await ask(capture, { baseUrl: "https://rates.example.test/v1///" });
    expect(seen).toEqual(["https://rates.example.test/v1/2026-11-02?base=EUR&symbols=SGD"]);
  });

  it("defaults to the public Frankfurter v1 endpoint", () => {
    expect(FRANKFURTER_BASE_URL).toBe("https://api.frankfurter.dev/v1");
  });
});
