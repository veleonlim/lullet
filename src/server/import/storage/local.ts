import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertStorageKey, type ImageStorage, type StoredImage } from "./types";

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** Development and test storage: one file per object under a directory. */
export class LocalFileStorage implements ImageStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = path.resolve(directory);
  }

  private fileFor(key: string): string {
    assertStorageKey(key);
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return file;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async get(key: string): Promise<StoredImage | null> {
    const file = this.fileFor(key);
    try {
      const bytes = new Uint8Array(await readFile(file));
      const type = TYPE_BY_EXTENSION[path.extname(file).slice(1)] ?? "application/octet-stream";
      return { bytes, contentType: type };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
  }
}
