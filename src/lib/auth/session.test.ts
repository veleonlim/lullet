import { describe, expect, it } from "vitest";
import { SEED_GROUP_ID, SEED_MEMBERS } from "@/db/seed-ids";
import { isDevAuthEnabled, sessionFromEnvironment } from "./session";

describe("development sign-in stand-in", () => {
  it("is off unless LULLET_DEV_AUTH=1", () => {
    expect(isDevAuthEnabled({})).toBe(false);
    expect(isDevAuthEnabled({ LULLET_DEV_AUTH: "0" })).toBe(false);
    expect(isDevAuthEnabled({ LULLET_DEV_AUTH: "true" })).toBe(false);
    expect(sessionFromEnvironment({})).toBeNull();
  });

  it("returns the first seeded member of the seeded group when enabled", () => {
    const env = { LULLET_DEV_AUTH: "1", NODE_ENV: "development" };
    expect(isDevAuthEnabled(env)).toBe(true);
    expect(sessionFromEnvironment(env)).toEqual({
      userId: SEED_MEMBERS[0].id,
      groupId: SEED_GROUP_ID,
    });
  });

  it("never signs anyone in on a production build", () => {
    expect(isDevAuthEnabled({ LULLET_DEV_AUTH: "1", NODE_ENV: "production" })).toBe(false);
    expect(sessionFromEnvironment({ LULLET_DEV_AUTH: "1", NODE_ENV: "production" })).toBeNull();
  });

  it("never signs anyone in on Vercel production or preview, even with the end to end flag", () => {
    for (const VERCEL_ENV of ["production", "preview"]) {
      const env = { LULLET_DEV_AUTH: "1", LULLET_E2E: "1", NODE_ENV: "production", VERCEL_ENV };
      expect(isDevAuthEnabled(env)).toBe(false);
      expect(sessionFromEnvironment(env)).toBeNull();
    }
  });

  it("allows a production build only for the end to end suite", () => {
    const env = { LULLET_DEV_AUTH: "1", LULLET_E2E: "1", NODE_ENV: "production" };
    expect(isDevAuthEnabled(env)).toBe(true);
  });
});
