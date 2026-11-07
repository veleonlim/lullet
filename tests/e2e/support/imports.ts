import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { Extraction } from "@/lib/import/extraction";
import { makePng } from "@/test-support/images";

/**
 * Screenshot import helpers. The model is a stand-in: the server answers each image from a JSON
 * file named after the image's SHA-256 in the stub folder (see playwright.config.ts), so a test
 * decides what "Claude read" by writing that file before it uploads.
 */

function stubDirectory(): string {
  const dir = process.env.E2E_STUB_DIR;
  if (!dir) throw new Error("E2E_STUB_DIR is not set (see playwright.config.ts)");
  return dir;
}

export async function resetStubs(): Promise<void> {
  await rm(stubDirectory(), { recursive: true, force: true });
  await mkdir(stubDirectory(), { recursive: true });
}

export interface TestScreenshot {
  readonly name: string;
  readonly mimeType: "image/png";
  readonly buffer: Buffer;
  readonly sha256: string;
}

/** A real PNG; different seeds give different images (and so different hashes). */
export function screenshot(seed: number): TestScreenshot {
  const buffer = Buffer.from(makePng({ width: 360, height: 640, seed }));
  return {
    name: `screenshot-${String(seed)}.png`,
    mimeType: "image/png",
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/** What the stand-in model "reads" from this image. */
export async function stubRead(
  image: TestScreenshot,
  answer: Extraction | { failure: "refused" | "max_tokens" | "malformed" | "api_error" },
  variant: "first" | "reread" = "first",
): Promise<void> {
  await mkdir(stubDirectory(), { recursive: true });
  const file = variant === "reread" ? `${image.sha256}.reread.json` : `${image.sha256}.json`;
  await writeFile(path.join(stubDirectory(), file), JSON.stringify(answer));
}

/** Chooses the file on the upload page, reads it and waits for the review screen. */
export async function uploadAndReview(page: Page, image: TestScreenshot): Promise<string> {
  await page.goto("/imports/new");
  await page.locator("#screenshot").setInputFiles(image);
  await expect(page.getByRole("img", { name: "The screenshot you chose" })).toBeVisible();
  await page.getByRole("button", { name: "Read screenshot" }).click();
  await page.waitForURL(/\/imports\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return /\/imports\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? "";
}

export function rowFor(page: Page, merchant: string): Locator {
  return page.getByTestId("import-row").filter({ hasText: merchant });
}

export function personTotal(page: Page, name: string): Locator {
  return page.getByTestId("person-total").filter({ hasText: name });
}
