import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import { cancelImport, uploadScreenshot } from "@/server/import/service";
import { runRetention } from "@/server/import/retention";
import { LocalFileStorage } from "@/server/import/storage";
import { makePng } from "@/test-support/images";
import { extraction, transaction } from "@/test-support/extraction";
import { closeTestDb, resetDatabase, seedGroup, testDb, type Seed } from "./helpers";
import { buildWorld, ok, unchanged, type World } from "./import-support";
import { storeFor } from "./ledger-support";

const db = testDb();
let seed: Seed;
let world: World;

beforeEach(async () => {
  await resetDatabase(db);
  seed = await seedGroup(db);
  world = buildWorld(db, seed);
});
afterAll(closeTestDb);

async function upload(n: number) {
  world.extractor.enqueue(
    ok(
      extraction([
        transaction({
          merchant: `Place ${String(n)}`,
          amount_text: `€${String(n)},00`,
          amount_value: `${String(n)}.00`,
        }),
      ]),
    ),
  );
  const { importId } = await uploadScreenshot(world.as(0), {
    bytes: makePng({ seed: n }),
    source: "web",
  });
  const view = await world.store(0).getDraft(importId);
  if (!view) throw new Error("missing");
  return view;
}

const retention = () => runRetention({ db, storage: world.storage, now: () => world.clock.now });
const record = async (id: string) => {
  const [row] = await db.select().from(s.imports).where(eq(s.imports.id, id));
  if (!row) throw new Error("missing import");
  return row;
};

describe("the 30 day retention job", () => {
  it("deletes the original 30 days after confirm and keeps the extracted rows and expenses", async () => {
    const view = await upload(1);
    await world.store(0).confirm(view.id, unchanged(view));

    world.clock.now = new Date("2026-12-07T09:59:00Z"); // 29 days 23 hours 59 minutes later
    expect(await retention()).toEqual({ expiredDrafts: 0, deletedImages: 0, failedImages: 0 });
    expect(world.storage.objects.size).toBe(1);

    world.clock.now = new Date("2026-12-08T10:00:00Z"); // exactly 30 days later
    expect(await retention()).toEqual({ expiredDrafts: 0, deletedImages: 1, failedImages: 0 });
    expect(world.storage.objects.size).toBe(0);

    const after = await record(view.id);
    expect(after.storageKey).toBeNull();
    expect(after.imageDeletedAt?.toISOString()).toBe("2026-12-08T10:00:00.000Z");
    expect(after.status).toBe("confirmed");
    expect(
      await db.select().from(s.importRows).where(eq(s.importRows.importId, view.id)),
    ).toHaveLength(1);
    expect(await storeFor(db, seed).listExpenses()).toHaveLength(1);
    expect((await world.store(0).getDraft(view.id))?.imageAvailable).toBe(false);

    const log = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, "import.image_deleted"));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorUserId: null, groupId: seed.groupId, entityId: view.id });
  });

  it("also deletes the original of an import that was undone, 30 days after it was confirmed", async () => {
    const view = await upload(2);
    await world.store(0).confirm(view.id, unchanged(view));
    await world.store(0).undo(view.id);
    world.clock.now = new Date("2026-12-09T00:00:00Z");
    expect((await retention()).deletedImages).toBe(1);
  });

  it("is safe to run again", async () => {
    const view = await upload(3);
    await world.store(0).confirm(view.id, unchanged(view));
    world.clock.now = new Date("2026-12-20T00:00:00Z");
    expect((await retention()).deletedImages).toBe(1);
    expect(await retention()).toEqual({ expiredDrafts: 0, deletedImages: 0, failedImages: 0 });
    expect(
      await db.select().from(s.auditLog).where(eq(s.auditLog.action, "import.image_deleted")),
    ).toHaveLength(1);
  });

  it("expires drafts after 24 hours, discards their rows and deletes their originals", async () => {
    const view = await upload(4);
    world.clock.now = new Date("2026-11-09T10:00:01Z");
    expect(await retention()).toEqual({ expiredDrafts: 1, deletedImages: 1, failedImages: 0 });
    expect((await record(view.id)).status).toBe("expired");
    expect(await db.select().from(s.importRows).where(eq(s.importRows.importId, view.id))).toEqual(
      [],
    );
    expect(world.storage.objects.size).toBe(0);
    expect(await storeFor(db, seed).listExpenses()).toEqual([]);
  });

  it("only touches what is due: a recent import keeps its original", async () => {
    const draft = await upload(5);
    const confirmed = await upload(6);
    await world.store(0).confirm(confirmed.id, unchanged(confirmed));
    world.clock.now = new Date("2026-11-20T10:00:00Z");
    expect(await retention()).toEqual({ expiredDrafts: 1, deletedImages: 1, failedImages: 0 });
    expect((await record(draft.id)).status).toBe("expired");
    expect((await record(confirmed.id)).storageKey).not.toBeNull();
    expect(world.storage.objects.size).toBe(1);
  });

  it("sweeps up the original of a cancelled draft whose deletion failed at cancel time", async () => {
    const view = await upload(7);
    world.storage.failDeletes = true;
    await cancelImport(world.as(0), view.id);
    expect(world.storage.objects.size).toBe(1);
    expect(await retention()).toMatchObject({ deletedImages: 0, failedImages: 1 });
    world.storage.failDeletes = false;
    expect(await retention()).toMatchObject({ deletedImages: 1, failedImages: 0 });
    expect(world.storage.objects.size).toBe(0);
  });

  it("keeps going when one original cannot be deleted and tries it again next time", async () => {
    const a = await upload(8);
    const b = await upload(9);
    await world.store(0).confirm(a.id, unchanged(a));
    await world.store(0).confirm(b.id, unchanged(b));
    const aKey = (await record(a.id)).storageKey ?? "";
    const real = world.storage.delete.bind(world.storage);
    world.storage.delete = (key: string) =>
      key === aKey ? Promise.reject(new Error("storage is down")) : real(key);
    world.clock.now = new Date("2026-12-20T00:00:00Z");
    expect(await retention()).toMatchObject({ deletedImages: 1, failedImages: 1 });
    expect((await record(a.id)).storageKey).toBe(aKey);
    world.storage.delete = real;
    expect(await retention()).toMatchObject({ deletedImages: 1, failedImages: 0 });
  });
});

describe("the scheduled route", () => {
  async function call(headers: Record<string, string>, method = "GET") {
    vi.resetModules();
    const route = await import("@/app/api/cron/retention/route");
    const request = new Request("http://localhost/api/cron/retention", { method, headers });
    return method === "GET" ? route.GET(request) : route.POST(request);
  }

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL ?? "");
    vi.stubEnv("LULLET_STORAGE_DIR", "/tmp/lullet-retention-route-test");
    vi.stubEnv("NODE_ENV", "test");
    delete (globalThis as { __lulletDb?: unknown }).__lulletDb;
    delete (globalThis as { __lulletStorage?: unknown }).__lulletStorage;
  });

  it("is closed when no secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call({ authorization: "Bearer anything" })).status).toBe(503);
  });

  it("refuses a missing or wrong secret", async () => {
    vi.stubEnv("CRON_SECRET", "right-secret-0123456789");
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call({ authorization: "right-secret-0123456789" })).status).toBe(401);
    expect((await call({ authorization: "Basic right-secret-0123456789" })).status).toBe(401);
  });

  it("runs the clean-up for the right secret, on GET (Vercel Cron) and POST", async () => {
    vi.stubEnv("CRON_SECRET", "right-secret-0123456789");
    const storage = new LocalFileStorage("/tmp/lullet-retention-route-test");
    const [group] = await db.insert(s.groups).values({ name: "Route test" }).returning();
    const [user] = await db.insert(s.users).values({ displayName: "Tester" }).returning();
    await db
      .insert(s.memberships)
      .values({ groupId: group?.id ?? "", userId: user?.id ?? "", position: 0 });
    const [stale] = await db
      .insert(s.imports)
      .values({
        groupId: group?.id ?? "",
        uploaderId: user?.id ?? "",
        source: "web",
        imageSha256: "b".repeat(64),
        status: "draft",
        storageKey: "imports/route/test.png",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();
    await storage.put("imports/route/test.png", makePng());

    const response = await call({ authorization: "Bearer right-secret-0123456789" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ expiredDrafts: 1, deletedImages: 1, failedImages: 0 });
    expect(await storage.get("imports/route/test.png")).toBeNull();
    expect((await record(stale?.id ?? "")).status).toBe("expired");

    const again = await call({ authorization: "Bearer right-secret-0123456789" }, "POST");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ expiredDrafts: 0, deletedImages: 0, failedImages: 0 });
  });
});
