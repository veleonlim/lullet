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
import {
  createStorageFromEnv,
  LocalFileStorage,
  S3Storage,
  assertStorageKey,
  storageKeyFor,
} from ".";
import type { ImageStorage } from "./types";

const BYTES = Uint8Array.from([1, 2, 3, 4, 5]);

/** The behaviour every adapter must have. */
function contract(name: string, make: () => Promise<ImageStorage>) {
  describe(`${name} adapter`, () => {
    it("stores, reads back and deletes an object", async () => {
      const storage = await make();
      const key = storageKeyFor("g1", "i1", "png");
      await storage.put(key, BYTES, "image/png");
      const read = await storage.get(key);
      expect(Array.from(read?.bytes ?? [])).toEqual([1, 2, 3, 4, 5]);
      expect(read?.contentType).toBe("image/png");
      await storage.delete(key);
      expect(await storage.get(key)).toBeNull();
    });

    it("reports a missing object as null and deleting it is not an error", async () => {
      const storage = await make();
      expect(await storage.get("imports/g1/missing.png")).toBeNull();
      await expect(storage.delete("imports/g1/missing.png")).resolves.toBeUndefined();
    });

    it("overwrites an existing key", async () => {
      const storage = await make();
      await storage.put("imports/g1/a.jpg", BYTES, "image/jpeg");
      await storage.put("imports/g1/a.jpg", Uint8Array.from([9]), "image/jpeg");
      expect(Array.from((await storage.get("imports/g1/a.jpg"))?.bytes ?? [])).toEqual([9]);
    });

    it("refuses keys that could escape the bucket or directory", async () => {
      const storage = await make();
      for (const key of ["../x", "/etc/passwd", "a/../../b", "", "a//b", "a b", "x".repeat(301)]) {
        await expect(storage.put(key, BYTES, "image/png")).rejects.toThrow("Invalid storage key");
        await expect(storage.get(key)).rejects.toThrow("Invalid storage key");
        await expect(storage.delete(key)).rejects.toThrow("Invalid storage key");
      }
    });
  });
}

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

  it("uses R2 when all four settings are present", () => {
    expect(createStorageFromEnv({ ...s3, NODE_ENV: "production" })).toBeInstanceOf(S3Storage);
  });

  it("uses a local directory in development and test", () => {
    expect(createStorageFromEnv({ NODE_ENV: "development" })).toBeInstanceOf(LocalFileStorage);
    expect(
      createStorageFromEnv({ NODE_ENV: "test", LULLET_STORAGE_DIR: directory }),
    ).toBeInstanceOf(LocalFileStorage);
  });

  it("refuses to fall back to local files in production unless asked to", () => {
    expect(() => createStorageFromEnv({ NODE_ENV: "production" })).toThrow("not configured");
    expect(() => createStorageFromEnv({ ...s3, S3_BUCKET: "", NODE_ENV: "production" })).toThrow(
      "not configured",
    );
    expect(
      createStorageFromEnv({ NODE_ENV: "production", LULLET_STORAGE: "local" }),
    ).toBeInstanceOf(LocalFileStorage);
  });
});
