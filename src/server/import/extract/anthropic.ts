import Anthropic from "@anthropic-ai/sdk";
import {
  buildUserPrompt,
  EXTRACTION_JSON_SCHEMA,
  parseExtraction,
  SYSTEM_PROMPT,
} from "@/lib/import/extraction";
import {
  EXTRACTION_MODELS,
  type ExtractionOutcome,
  type ExtractionRequest,
  type ImageExtractor,
} from "./types";

/** The one call of the SDK this module makes, so tests can stand in for the network. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** Plenty for 60 rows; hitting it means the answer is cut off and not to be trusted. */
export const MAX_OUTPUT_TOKENS = 8000;

/**
 * Reads screenshots with Claude. One request per read, no tools, answer constrained to the JSON
 * schema (`output_config.format`) and validated again by our own parser. The API key comes only
 * from the environment. Nothing from the image or the reply is ever written to logs.
 */
export class AnthropicExtractor implements ImageExtractor {
  private client: MessagesClient | undefined;

  constructor(
    client?: MessagesClient,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.client = client;
  }

  private getClient(): MessagesClient | undefined {
    if (this.client) return this.client;
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return undefined;
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    return this.client;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
    const model = request.model;
    const client = this.getClient();
    if (!client) return { ok: false, model, failure: "not_configured" };

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: {
          // Reading a screenshot needs little reasoning; the stronger model gets a bit more.
          effort: model === EXTRACTION_MODELS.default ? "low" : "medium",
          format: { type: "json_schema", schema: EXTRACTION_JSON_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: request.mediaType,
                  data: Buffer.from(request.bytes).toString("base64"),
                },
              },
              { type: "text", text: buildUserPrompt(request.today) },
            ],
          },
        ],
      });
    } catch (error) {
      // Only the kind of failure is logged: error messages can echo request details.
      console.error(
        "Screenshot read failed",
        error instanceof Anthropic.APIError
          ? `${error.name} ${String(error.status)}`
          : "unexpected error",
      );
      return { ok: false, model, failure: "api_error" };
    }

    if (response.stop_reason === "refusal") return { ok: false, model, failure: "refused" };
    if (response.stop_reason === "max_tokens") return { ok: false, model, failure: "max_tokens" };

    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const parsed = parseExtraction(reply);
    if (!parsed.ok) return { ok: false, model, failure: "malformed" };
    return { ok: true, model, extraction: parsed.value };
  }
}
