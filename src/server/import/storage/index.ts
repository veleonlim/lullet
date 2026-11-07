import { LocalFileStorage } from "./local";
import { S3Storage } from "./s3";
import type { ImageStorage } from "./types";

export * from "./local";
export * from "./s3";
export * from "./types";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Picks the storage from the environment. All four S3 variables select Cloudflare R2. Otherwise
 * the local directory (`LULLET_STORAGE_DIR`, default `.data/screenshots`) is used, but only in
 * development or when `LULLET_STORAGE=local` is set explicitly: a production deployment that
 * lost its bucket settings must fail loudly, not quietly keep screenshots on a disk that vanishes.
 */
export function createStorageFromEnv(env: Env): ImageStorage {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    return new S3Storage({
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    });
  }
  if (env.NODE_ENV === "production" && env.LULLET_STORAGE !== "local") {
    throw new Error(
      "Screenshot storage is not configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
    );
  }
  return new LocalFileStorage(env.LULLET_STORAGE_DIR ?? ".data/screenshots");
}

const globalForStorage = globalThis as unknown as { __lulletStorage?: ImageStorage };

/** The process wide storage, created on first use. */
export function getStorage(): ImageStorage {
  globalForStorage.__lulletStorage ??= createStorageFromEnv(process.env);
  return globalForStorage.__lulletStorage;
}
