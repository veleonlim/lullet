import { AnthropicExtractor } from "./anthropic";
import { StubExtractor } from "./stub";
import type { ImageExtractor } from "./types";

export * from "./anthropic";
export * from "./stub";
export * from "./types";

/** The real model, unless `LULLET_EXTRACTOR=stub` (end to end tests) points at a folder of canned answers. */
export function createExtractorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ImageExtractor {
  if (env.LULLET_EXTRACTOR === "stub") {
    return new StubExtractor(env.LULLET_STUB_DIR ?? ".data/stub-extractions");
  }
  return new AnthropicExtractor(undefined, env);
}

const globalForExtractor = globalThis as unknown as { __lulletExtractor?: ImageExtractor };

export function getExtractor(): ImageExtractor {
  globalForExtractor.__lulletExtractor ??= createExtractorFromEnv(process.env);
  return globalForExtractor.__lulletExtractor;
}
