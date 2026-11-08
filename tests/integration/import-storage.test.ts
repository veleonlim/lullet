import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { PostgresStorage } from "@/server/import/storage";
import { storageContract } from "@/test-support/storage-contract";
import { closeTestDb, testDb } from "./helpers";

const db = testDb();
const storage = new PostgresStorage(db);

beforeEach(async () => {
  await db.delete(s.importImages);
});
afterAll(closeTestDb);

storageContract("Postgres", () => Promise.resolve(storage));

describe("Postgres screenshot storage", () => {
  it("keeps the exact bytes of a binary image and its type in one row", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await storage.put("imports/g/a.png", bytes, "image/png");
    const rows = await db.select().from(s.importImages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ storageKey: "imports/g/a.png", contentType: "image/png" });
    const read = await storage.get("imports/g/a.png");
    expect(Array.from(read?.bytes ?? [])).toEqual(Array.from(bytes));
  });

  it("stores a 4 MB image, the most the upload limit allows", async () => {
    const bytes = new Uint8Array(4_000_000).map((_, i) => (i * 31) % 251);
    await storage.put("imports/g/big.jpg", bytes, "image/jpeg");
    const read = await storage.get("imports/g/big.jpg");
    expect(read?.bytes.length).toBe(4_000_000);
    expect(Buffer.from(read?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
  });

  it("does not mix up a view into a larger buffer with the whole buffer", async () => {
    const whole = Uint8Array.from([0, 0, 7, 8, 9, 0, 0]);
    await storage.put("imports/g/view.png", whole.subarray(2, 5), "image/png");
    expect(Array.from((await storage.get("imports/g/view.png"))?.bytes ?? [])).toEqual([7, 8, 9]);
  });

  it("deletes only the key it is given", async () => {
    await storage.put("imports/g/a.png", Uint8Array.from([1]), "image/png");
    await storage.put("imports/g/b.png", Uint8Array.from([2]), "image/png");
    await storage.delete("imports/g/a.png");
    expect(await storage.get("imports/g/a.png")).toBeNull();
    expect(Array.from((await storage.get("imports/g/b.png"))?.bytes ?? [])).toEqual([2]);
  });
});
