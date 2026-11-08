/**
 * Where original screenshots live. They are private: nothing in the app hands out a public or
 * pre-signed URL; the app reads the bytes through this interface and serves them itself, to
 * signed-in members of the group only. Adapters: the database in production, the local file
 * system for development and tests, and Cloudflare R2 (S3 compatible) as an optional extra.
 */
export interface StoredImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface ImageStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Null when there is no such object (never stored, or already deleted). */
  get(key: string): Promise<StoredImage | null>;
  /** Deleting something that is not there is not an error. */
  delete(key: string): Promise<void>;
}

/** Keys are made by the app (`imports/<group>/<import>.<ext>`); anything else is refused. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.length > 300) {
    throw new Error("Invalid storage key");
  }
}

export function storageKeyFor(groupId: string, importId: string, extension: string): string {
  const key = `imports/${groupId}/${importId}.${extension}`;
  assertStorageKey(key);
  return key;
}
