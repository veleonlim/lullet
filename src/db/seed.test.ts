import { describe, expect, it } from "vitest";
import { resetLedger, isLocalDatabaseUrl } from "./seed";
import type { Database } from "./client";

describe("isLocalDatabaseUrl", () => {
  it.each([
    "postgres://lullet:lullet@localhost:5432/lullet",
    "postgresql://lullet@127.0.0.1/lullet",
    "postgres://lullet@[::1]:5432/lullet",
    "postgres://lullet@LOCALHOST/lullet",
  ])("accepts %s", (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
  });

  it.each([
    "postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    "postgres://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb",
    "postgres://u:p@db.example.com:5432/lullet",
    "postgres://u:p@10.0.0.5/lullet",
    "postgres://u:p@localhost.example.com/lullet",
    "postgres://u:p@localhost/lullet?host=db.example.com",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });
});

describe("resetLedger", () => {
  it("refuses a remote database without touching it", async () => {
    const db = {
      execute: () => Promise.reject(new Error("must not run")),
    } as unknown as Database;
    await expect(
      resetLedger(db, "postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb"),
    ).rejects.toThrow(/not local/);
  });
});
