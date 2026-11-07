/**
 * `pnpm eval:screenshots <folder> [--model haiku|sonnet|both] [--out report.json]`
 *
 * Manual accuracy eval against the LIVE Claude API (costs a few cents; never runs in CI). The folder
 * holds real, redacted screenshots (`name.png`, `.jpg` or `.webp`) each with a golden answer in
 * `name.json`:
 *
 *   { "transactions": [
 *       { "merchant": "Trattoria Roma", "date": "2026-11-03", "amount": "48.50", "currency": "EUR",
 *         "category": "food" },
 *       { "merchant": "Hotel Lumiere", "date": "2026-11-04", "amount": "424.80", "currency": "EUR",
 *         "billedAmount": "640.00", "billedCurrency": "SGD", "category": "stay" } ] }
 *
 * It reads every screenshot with the same code the app uses (extraction, our own re-parse of the
 * amounts, doubt flags) and reports per field accuracy plus "silent errors": wrong values the review
 * screen would not have marked as "check". That number, not raw accuracy, says whether Haiku 5.5 is
 * safe as the default or Sonnet 5.5 should be. Without ANTHROPIC_API_KEY it does nothing.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVAL_FIELDS,
  goldenSchema,
  inspectImage,
  normalizeExtraction,
  scoreImage,
  summarize,
  type ImageScore,
} from "@/lib/import";
import { todayIn } from "@/lib/ledger/days";
import {
  AnthropicExtractor,
  EXTRACTION_MODELS,
  type ExtractionModel,
} from "@/server/import/extract";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const folder = args.find(
  (arg, index) => !arg.startsWith("--") && args[index - 1]?.startsWith("--") !== true,
);

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(
    "Skipped: ANTHROPIC_API_KEY is not set. This eval calls the live API and needs a key.",
  );
  process.exit(0);
}
if (!folder) {
  console.error(
    "Usage: pnpm eval:screenshots <folder> [--model haiku|sonnet|both] [--out report.json]",
  );
  process.exit(1);
}

const which = flag("--model") ?? "both";
const models: ExtractionModel[] =
  which === "haiku"
    ? [EXTRACTION_MODELS.default]
    : which === "sonnet"
      ? [EXTRACTION_MODELS.reread]
      : [EXTRACTION_MODELS.default, EXTRACTION_MODELS.reread];

const names = (await readdir(folder)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
if (names.length === 0) {
  console.log(`Skipped: no screenshots (.png, .jpg, .webp) found in ${folder}.`);
  process.exit(0);
}

const extractor = new AnthropicExtractor();
const today = todayIn(new Date());
const report: Record<string, unknown> = {};

for (const model of models) {
  const scores: ImageScore[] = [];
  const failures: string[] = [];
  for (const name of names) {
    const goldenPath = path.join(folder, name.replace(/\.[^.]+$/, ".json"));
    let golden;
    try {
      golden = goldenSchema.parse(JSON.parse(await readFile(goldenPath, "utf8")));
    } catch {
      console.log(`  skip ${name}: no valid golden file ${path.basename(goldenPath)}`);
      continue;
    }
    const image = inspectImage(new Uint8Array(await readFile(path.join(folder, name))));
    if (!image.ok) {
      console.log(`  skip ${name}: ${image.reason}`);
      continue;
    }
    const outcome = await extractor.extract({
      bytes: image.clean,
      mediaType: image.type,
      model,
      today,
    });
    if (!outcome.ok) {
      failures.push(`${name}: ${outcome.failure}`);
      scores.push(scoreImage(golden, []));
      continue;
    }
    scores.push(scoreImage(golden, normalizeExtraction(outcome.extraction, today).rows));
  }

  const summary = summarize(scores);
  report[model] = { summary, failures };
  console.log(
    `\n${model}: ${String(summary.images)} screenshots, ${String(summary.goldenRows)} rows`,
  );
  console.log(
    `  overall ${String(summary.overall)}%  missed rows ${String(summary.missed)}  extra rows ${String(summary.extra)}`,
  );
  for (const field of EVAL_FIELDS) {
    const f = summary.fields[field];
    console.log(
      `  ${field.padEnd(9)} ${String(f.accuracy).padStart(3)}%  (${String(f.correct)}/${String(f.total)})  silent errors ${String(f.silentErrors)}`,
    );
  }
  for (const failure of failures) console.log(`  read failed: ${failure}`);
}

const out = flag("--out");
if (out) {
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${out}`);
}
