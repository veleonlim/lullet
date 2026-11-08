import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Screenshots, model replies, tokens and connection strings must never reach the logs. A caught
 * error can carry any of them in its message or its fields, so server code logs the kind of
 * failure (`error.name`, `describeFailure(error)`) and never passes the error object itself.
 */

const root = path.resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !entry.includes(".test.") && !full.includes("test-support")
      ? [full]
      : [];
  });
}

describe("logging", () => {
  const calls = sourceFiles(root).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/console\.\w+\(((?:[^()]|\([^()]*\))*)\)/g)].map(
      (match) => ({ file: path.relative(root, file), args: match[1] ?? "" }),
    ),
  );

  it("finds the logging calls it is meant to police", () => {
    expect(calls.length).toBeGreaterThan(5);
  });

  it("never logs a caught error object, only its kind", () => {
    const offenders = calls.filter((call) =>
      /(?:^|,)\s*(?:error|err|e|cause|reason)\s*$/.test(call.args.trim()),
    );
    expect(offenders).toEqual([]);
  });

  it("never logs a request body, bytes or a secret by name", () => {
    const offenders = calls.filter((call) =>
      /\b(bytes|body|token|secret|apiKey|password|connectionString|reply|response\.content)\b/i.test(
        call.args.replace(/"[^"]*"/g, ""),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
