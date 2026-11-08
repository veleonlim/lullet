import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
  framework?: string;
  buildCommand?: string;
  regions?: string[];
  crons?: { path: string; schedule: string }[];
};

describe("vercel.json", () => {
  it("builds the Next.js app with the repository's own scripts", () => {
    expect(config.framework).toBe("nextjs");
    expect(config.buildCommand).toBe("pnpm build");
  });

  it("runs functions in Frankfurt, next to the Neon database the launch guide asks for", () => {
    expect(config.regions).toEqual(["fra1"]);
  });

  it("schedules the retention clean-up once a day, which is all a Hobby plan allows", () => {
    expect(config.crons).toEqual([{ path: "/api/cron/retention", schedule: "17 3 * * *" }]);
    for (const cron of config.crons ?? []) {
      expect(cron.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
      const route = path.join(root, "src/app", cron.path, "route.ts");
      expect(existsSync(route), cron.path).toBe(true);
    }
  });

  it("has a cron entry for every scheduled job the app defines", () => {
    // A scheduled job is a route under /api/cron: each one needs a schedule, or it never runs.
    const jobs: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts")
          jobs.push(`/${path.relative(path.join(root, "src/app"), path.dirname(full))}`);
      }
    };
    walk(path.join(root, "src/app/api/cron"));
    expect(jobs.sort()).toEqual((config.crons ?? []).map((cron) => cron.path).sort());
  });

  it("keeps every long-running route within the 60 second function limit", () => {
    for (const route of [
      "src/app/api/imports/route.ts",
      "src/app/api/imports/[id]/reread/route.ts",
      "src/app/api/telegram/webhook/route.ts",
      "src/app/api/cron/retention/route.ts",
    ]) {
      const source = readFileSync(path.join(root, route), "utf8");
      expect(source, route).toMatch(/export const maxDuration = 60;/);
    }
  });
});
