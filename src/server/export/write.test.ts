import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportFolderName, writeExport } from "./write";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lullet-export-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("exportFolderName", () => {
  it("sorts by time", () => {
    expect(exportFolderName(new Date("2026-11-08T15:30:45Z"))).toBe(
      "lullet-export-2026-11-08-1530",
    );
  });
});

describe("writeExport", () => {
  const files = [
    { name: "a.csv", rows: 1, content: "﻿id\r\n1\r\n" },
    { name: "b.csv", rows: 0, content: "﻿id\r\n" },
  ];

  it("creates the folder, writes every file privately and keeps the bytes intact", async () => {
    const directory = path.join(root, "nested", "one");
    await writeExport(directory, files);
    expect((await readdir(directory)).sort()).toEqual(["a.csv", "b.csv"]);
    expect(await readFile(path.join(directory, "a.csv"), "utf8")).toBe(files[0]?.content);
    expect((await stat(path.join(directory, "a.csv"))).mode & 0o077).toBe(0);
  });

  it("refuses to overwrite an earlier export", async () => {
    const directory = path.join(root, "again");
    await writeExport(directory, files);
    await expect(writeExport(directory, files)).rejects.toThrow("already exists");
    expect(await readFile(path.join(directory, "a.csv"), "utf8")).toBe(files[0]?.content);
  });

  it("passes other failures through", async () => {
    const blocker = path.join(root, "blocker");
    await writeExport(blocker, files);
    await expect(writeExport(path.join(blocker, "a.csv", "inside"), files)).rejects.toThrow();
  });
});
