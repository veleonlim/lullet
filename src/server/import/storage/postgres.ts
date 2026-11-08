import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import { assertStorageKey, type ImageStorage, type StoredImage } from "./types";

/**
 * The default storage: the screenshot's bytes in a `bytea` column of `import_images`, in the same
 * database as everything else, so a deployment needs no object store account. Screenshots are
 * kept only while a draft is open (see `import_images` in the schema), which keeps the table to a
 * handful of rows; each is at most `MAX_UPLOAD_BYTES` (4 MB).
 */
export class PostgresStorage implements ImageStorage {
  constructor(private readonly db: Database) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertStorageKey(key);
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    await this.db
      .insert(s.importImages)
      .values({ storageKey: key, contentType, bytes: data })
      .onConflictDoUpdate({
        target: s.importImages.storageKey,
        set: { contentType, bytes: data, createdAt: new Date() },
      });
  }

  async get(key: string): Promise<StoredImage | null> {
    assertStorageKey(key);
    const [row] = await this.db
      .select({ bytes: s.importImages.bytes, contentType: s.importImages.contentType })
      .from(s.importImages)
      .where(eq(s.importImages.storageKey, key));
    if (!row) return null;
    return { bytes: new Uint8Array(row.bytes), contentType: row.contentType };
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.db.delete(s.importImages).where(eq(s.importImages.storageKey, key));
  }
}
