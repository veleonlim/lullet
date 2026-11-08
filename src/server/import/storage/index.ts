import { getDatabase, type Database } from "@/db/client";
import { LocalFileStorage } from "./local";
import { PostgresStorage } from "./postgres";
import { S3Storage } from "./s3";
import type { ImageStorage } from "./types";

export * from "./local";
export * from "./postgres";
export * from "./s3";
export * from "./types";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Picks the storage from the environment:
 *
 *  - all four S3 variables select an S3 compatible bucket (Cloudflare R2), an optional extra;
 *  - otherwise a production deployment keeps screenshots in its own database, so nothing beyond
 *    `DATABASE_URL` is needed;
 *  - development and tests use a local directory (`LULLET_STORAGE_DIR`, default
 *    `.data/screenshots`); `LULLET_STORAGE=local` asks for that in a production build too (the end
 *    to end suite does), and `LULLET_STORAGE=postgres` asks for the database outside production.
 *
 * `database` is only called when the database is the storage, so nothing else needs a connection.
 */
export function createStorageFromEnv(env: Env, database: () => Database): ImageStorage {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    return new S3Storage({
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    });
  }
  const wanted = env.LULLET_STORAGE;
  const inDatabase = wanted === "postgres" || (env.NODE_ENV === "production" && wanted !== "local");
  if (inDatabase) return new PostgresStorage(database());
  return new LocalFileStorage(env.LULLET_STORAGE_DIR ?? ".data/screenshots");
}

const globalForStorage = globalThis as unknown as { __lulletStorage?: ImageStorage };

/** The process wide storage, created on first use. */
export function getStorage(): ImageStorage {
  globalForStorage.__lulletStorage ??= createStorageFromEnv(process.env, () => getDatabase().db);
  return globalForStorage.__lulletStorage;
}
