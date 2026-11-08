import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExportFile } from "@/lib/export/ledger-csv";

/** A folder name that sorts by time and never repeats within a minute: `lullet-export-2026-11-08-1530`. */
export function exportFolderName(now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  return `lullet-export-${stamp}`;
}

/**
 * Writes the files into a new folder. Refuses a folder that already exists, so an export can
 * never overwrite an earlier one. Files are readable by the owner only.
 */
export async function writeExport(directory: string, files: readonly ExportFile[]): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${directory} already exists. Choose another folder with --out.`);
    }
    throw error;
  }
  for (const file of files) {
    await writeFile(path.join(directory, file.name), file.content, { mode: 0o600 });
  }
}
