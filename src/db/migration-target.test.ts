import { describe, expect, it } from "vitest";
import { assertDirectUrl, describeDatabaseTarget, isPooledUrl } from "./migration-target";

const POOLED =
  "postgresql://owner:hunter2@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const DIRECT =
  "postgresql://owner:hunter2@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require";

describe("describeDatabaseTarget", () => {
  it("prints the host and database and never the credentials", () => {
    expect(describeDatabaseTarget(DIRECT)).toBe("ep-cool-name.eu-central-1.aws.neon.tech/neondb");
    expect(describeDatabaseTarget("postgres://u:p@localhost:5432/lullet")).toBe(
      "localhost:5432/lullet",
    );
    expect(describeDatabaseTarget(DIRECT)).not.toContain("hunter2");
  });

  it("rejects something that is not an address", () => {
    expect(() => describeDatabaseTarget("nonsense")).toThrow("not a valid address");
  });
});

describe("assertDirectUrl", () => {
  it("recognises Neon's pooled host", () => {
    expect(isPooledUrl(POOLED)).toBe(true);
    expect(isPooledUrl(DIRECT)).toBe(false);
  });

  it("returns a direct address unchanged", () => {
    expect(assertDirectUrl(DIRECT)).toBe(DIRECT);
  });

  it("refuses a missing or pooled address with a message that says what to do", () => {
    expect(() => assertDirectUrl(undefined)).toThrow("DATABASE_URL_UNPOOLED is not set");
    expect(() => assertDirectUrl("  ")).toThrow("DATABASE_URL_UNPOOLED is not set");
    expect(() => assertDirectUrl(POOLED)).toThrow("pooler");
    try {
      assertDirectUrl(POOLED);
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});
