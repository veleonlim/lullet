import { describe, expect, it } from "vitest";
import { storageKeyFor, type ImageStorage } from "@/server/import/storage/types";

const BYTES = Uint8Array.from([1, 2, 3, 4, 5]);

/** The behaviour every screenshot storage adapter must have. */
export function storageContract(name: string, make: () => Promise<ImageStorage>) {
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
