import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageContract as contract } from "@/test-support/storage-contract";
import type { Database } from "@/db/client";
import {
  createStorageFromEnv,
  LocalFileStorage,
  PostgresStorage,
  S3Storage,
  assertStorageKey,
  storageKeyFor,
} from ".";
import type { ImageStorage } from "./types";

const BYTES = Uint8Array.from([1, 2, 3, 4, 5]);

let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "lullet-storage-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

contract("local file", () => Promise.resolve(new LocalFileStorage(directory)));

/** An in-memory stand-in for the S3 API, keyed by bucket and key. */
function fakeS3(): ImageStorage {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  return new S3Storage(
    {
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "shots",
      accessKeyId: "id",
      secretAccessKey: "secret",
    },
    {
      send(command) {
        if (command instanceof PutObjectCommand) {
          const { Bucket, Key, Body, ContentType } = command.input;
          expect(Bucket).toBe("shots");
          expect(command.input.CacheControl).toBe("private, no-store");
          objects.set(`${Bucket}/${Key}`, { body: Body as Uint8Array, type: ContentType ?? "" });
          return Promise.resolve({});
        }
        if (command instanceof GetObjectCommand) {
          const found = objects.get(`${command.input.Bucket}/${command.input.Key}`);
          if (!found) {
            return Promise.reject(
              new S3ServiceException({
                name: "NoSuchKey",
                $fault: "client",
                $metadata: { httpStatusCode: 404 },
                message: "missing",
              }),
            );
          }
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(found.body) },
            ContentType: found.type,
          });
        }
        if (command instanceof DeleteObjectCommand) {
          objects.delete(`${command.input.Bucket}/${command.input.Key}`);
          return Promise.resolve({});
        }
        return Promise.reject(new Error("unexpected command"));
      },
    },
  );
}

contract("S3 (Cloudflare R2)", () => Promise.resolve(fakeS3()));

describe("S3 errors", () => {
  const config = { endpoint: "https://x", bucket: "b", accessKeyId: "i", secretAccessKey: "s" };

  it("passes other failures on instead of hiding them", async () => {
    const storage = new S3Storage(config, {
      send: () =>
        Promise.reject(
          new S3ServiceException({
            name: "AccessDenied",
            $fault: "client",
            $metadata: { httpStatusCode: 403 },
            message: "no",
          }),
        ),
    });
    await expect(storage.get("imports/g/i.png")).rejects.toThrow("no");
  });

  it("treats an empty body as missing", async () => {
    const storage = new S3Storage(config, { send: () => Promise.resolve({}) });
    expect(await storage.get("imports/g/i.png")).toBeNull();
  });

  it("falls back to a generic content type", async () => {
    const storage = new S3Storage(config, {
      send: () => Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(BYTES) } }),
    });
    expect((await storage.get("imports/g/i.png"))?.contentType).toBe("application/octet-stream");
  });
});

describe("local adapter details", () => {
  it("reports the content type from the extension", async () => {
    const storage = new LocalFileStorage(directory);
    await storage.put("imports/g/x.webp", BYTES);
    expect((await storage.get("imports/g/x.webp"))?.contentType).toBe("image/webp");
    await storage.put("imports/g/x.bin", BYTES);
    expect((await storage.get("imports/g/x.bin"))?.contentType).toBe("application/octet-stream");
  });
});

describe("storage keys", () => {
  it("builds the key from ids and an extension", () => {
    expect(storageKeyFor("g-1", "i-1", "jpg")).toBe("imports/g-1/i-1.jpg");
    expect(() => assertStorageKey("imports/g-1/i-1.jpg")).not.toThrow();
  });
});

describe("createStorageFromEnv", () => {
  const s3 = {
    S3_ENDPOINT: "https://x.r2.cloudflarestorage.com",
    S3_BUCKET: "b",
    S3_ACCESS_KEY_ID: "i",
    S3_SECRET_ACCESS_KEY: "s",
  };
  const database = {} as Database;
  const noDatabase = () => {
    throw new Error("the database must not be touched");
  };

  it("uses R2 when all four settings are present, and never opens the database for it", () => {
    expect(createStorageFromEnv({ ...s3, NODE_ENV: "production" }, noDatabase)).toBeInstanceOf(
      S3Storage,
    );
  });

  it("keeps screenshots in the database in production when R2 is not set up", () => {
    expect(createStorageFromEnv({ NODE_ENV: "production" }, () => database)).toBeInstanceOf(
      PostgresStorage,
    );
    // Half an R2 setup is not R2.
    expect(
      createStorageFromEnv({ ...s3, S3_BUCKET: "", NODE_ENV: "production" }, () => database),
    ).toBeInstanceOf(PostgresStorage);
  });

  it("uses a local directory in development and test", () => {
    expect(createStorageFromEnv({ NODE_ENV: "development" }, noDatabase)).toBeInstanceOf(
      LocalFileStorage,
    );
    expect(
      createStorageFromEnv({ NODE_ENV: "test", LULLET_STORAGE_DIR: directory }, noDatabase),
    ).toBeInstanceOf(LocalFileStorage);
  });

  it("lets the settings choose the other one explicitly", () => {
    expect(
      createStorageFromEnv({ NODE_ENV: "production", LULLET_STORAGE: "local" }, noDatabase),
    ).toBeInstanceOf(LocalFileStorage);
    expect(
      createStorageFromEnv({ NODE_ENV: "development", LULLET_STORAGE: "postgres" }, () => database),
    ).toBeInstanceOf(PostgresStorage);
  });
});

describe("Postgres adapter keys", () => {
  it("checks the key before it touches the database", async () => {
    const storage = new PostgresStorage({} as Database);
    await expect(storage.get("../x")).rejects.toThrow("Invalid storage key");
    await expect(storage.put("a b", BYTES, "image/png")).rejects.toThrow("Invalid storage key");
    await expect(storage.delete("")).rejects.toThrow("Invalid storage key");
  });
});
