import { z } from "zod";
import type { CurrencyCode } from "@/lib/money/currency";
import { assertIsoDate, isIsoDate, type IsoDate } from "@/lib/money/dates";
import { parseRate, rateFromNumber } from "@/lib/money/rate";
import { FxRateError, type FxRateClient, type FxRateQuote } from "./types";

/**
 * Frankfurter (https://frankfurter.dev): free, keyless, daily ECB-based rates.
 * A request for a weekend or holiday answers with the last business day's rate
 * and says so in the `date` field, which becomes `rateDate`.
 */

export const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

const responseSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface FrankfurterOptions {
  readonly baseUrl?: string;
  /** Injected so tests replay recorded responses; defaults to the global fetch. */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export class FrankfurterClient implements FxRateClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: FrankfurterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? FRANKFURTER_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getRate(date: IsoDate, base: CurrencyCode, quote: CurrencyCode): Promise<FxRateQuote> {
    assertIsoDate(date, "date");
    if (base === quote) {
      return {
        provider: "frankfurter",
        base,
        quote,
        requestedDate: date,
        rateDate: date,
        rate: parseRate("1"),
      };
    }

    const url = `${this.baseUrl}/${date}?base=${base}&symbols=${quote}`;
    const response = await this.request(url);

    if (response.status === 404) {
      throw new FxRateError("not_found", `No ${base} to ${quote} rate for ${date}`);
    }
    if (!response.ok) {
      throw new FxRateError(
        "http_error",
        `Frankfurter answered HTTP ${response.status} for ${url}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new FxRateError("invalid_response", "Frankfurter returned a body that is not JSON", {
        cause,
      });
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      throw new FxRateError("invalid_response", "Frankfurter response has an unexpected shape", {
        cause: parsed.error,
      });
    }

    const { base: answeredBase, date: rateDate, rates } = parsed.data;
    const value = rates[quote];
    if (answeredBase !== base || value === undefined || !isIsoDate(rateDate) || rateDate > date) {
      throw new FxRateError(
        "invalid_response",
        `Frankfurter response does not match the ${base} to ${quote} request`,
      );
    }

    try {
      return {
        provider: "frankfurter",
        base,
        quote,
        requestedDate: date,
        rateDate,
        rate: rateFromNumber(value),
      };
    } catch (cause) {
      throw new FxRateError(
        "invalid_response",
        `Frankfurter returned an unusable rate: ${String(value)}`,
        { cause },
      );
    }
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new FxRateError("timeout", `Frankfurter did not answer within ${this.timeoutMs} ms`, {
          cause,
        });
      }
      throw new FxRateError("network_error", "Could not reach Frankfurter", { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}
