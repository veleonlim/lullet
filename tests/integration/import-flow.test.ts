import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { rowToEdit, type DraftEdit, type DraftView } from "@/lib/import";
import {
  DraftExpiredError,
  DraftInvalidError,
  DuplicateImageError,
  ImportConflictError,
  ImportError,
  ImportNotFoundError,
  NotUploaderError,
  RereadLimitError,
  UploadLimitError,
} from "@/server/import/errors";
import { cancelImport, rereadScreenshot, uploadScreenshot } from "@/server/import/service";
import { extraction, transaction, wireframeExtraction } from "@/test-support/extraction";
import { makeJpeg, makePng, pngChunk } from "@/test-support/images";
import { closeTestDb, resetDatabase, seedGroup, testDb, type Seed } from "./helpers";
import { storeFor } from "./ledger-support";
import { buildWorld, ok, unchanged, type World } from "./import-support";

const db = testDb();
let seed: Seed;
let world: World;

beforeEach(async () => {
  await resetDatabase(db);
  seed = await seedGroup(db);
  world = buildWorld(db, seed);
});
afterAll(closeTestDb);

const [A, B, C, D] = [0, 1, 2, 3] as const;
const id = (index: number) => seed.userIds[index] ?? "";

async function upload(as: number = A, bytes = makePng({ seed: 1 })) {
  const { importId } = await uploadScreenshot(world.as(as), { bytes, source: "web" });
  const view = await world.store(as).getDraft(importId);
  if (!view) throw new Error("draft missing");
  return view;
}

const ledgerCount = async () => (await storeFor(db, seed).listExpenses()).length;

describe("uploading a screenshot", () => {
  it("stores the original privately, reads it once and leaves a draft the balances do not see", async () => {
    const view = await upload();
    expect(view.status).toBe("draft");
    expect(view.model).toBe("claude-haiku-5-5");
    expect(view.rows.map((r) => [r.merchant, r.amountMinor, r.currency])).toEqual([
      ["Trattoria Roma", 4850, "EUR"],
      ["Metro Roma", 1200, "EUR"],
      ["AMZN Mktp", 2399, "EUR"],
      ["Louvre", 6400, "EUR"],
    ]);
    expect(view.screenTotal).toEqual({ text: "€148,49", minor: 14849, currency: "EUR" });
    expect(view.batch).toEqual({
      payerIds: [id(A)],
      includePayers: false,
      mode: "equal",
      percents: null,
    });
    expect(world.extractor.requests).toHaveLength(1);
    expect(world.extractor.requests[0]?.model).toBe("claude-haiku-5-5");
    expect(world.storage.objects.size).toBe(1);
    expect(await ledgerCount()).toBe(0);
    const ledger = await storeFor(db, seed).loadLedger();
    expect(ledger.expenses).toEqual([]);
  });

  it("expires the draft in 24 hours", async () => {
    const view = await upload();
    expect(view.expiresAt?.toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it("strips metadata before storing and before the model sees the image", async () => {
    const original = makeJpeg({ metadata: true });
    await upload(A, original);
    const [stored] = [...world.storage.objects.values()];
    const text = new TextDecoder("latin1").decode(stored?.bytes);
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("shot on a phone");
    expect(stored?.contentType).toBe("image/jpeg");
    const sent = new TextDecoder("latin1").decode(world.extractor.requests[0]?.bytes);
    expect(sent).not.toContain("GPS");
  });

  it("rejects the same image again without calling the model", async () => {
    const first = await upload();
    await expect(
      uploadScreenshot(world.as(B), { bytes: makePng({ seed: 1 }), source: "web" }),
    ).rejects.toMatchObject({ existingImportId: first.id });
    await expect(
      uploadScreenshot(world.as(A), { bytes: makePng({ seed: 1 }), source: "web" }),
    ).rejects.toBeInstanceOf(DuplicateImageError);
    expect(world.extractor.requests).toHaveLength(1);
    expect(world.storage.objects.size).toBe(1);
  });

  it("treats a copy that differs only in metadata as the same image", async () => {
    const note = pngChunk("tEXt", new TextEncoder().encode("Author\0Mei"));
    await upload(A, makePng({ seed: 4 }));
    await expect(
      uploadScreenshot(world.as(A), {
        bytes: makePng({ seed: 4, extraChunks: [note] }),
        source: "web",
      }),
    ).rejects.toBeInstanceOf(DuplicateImageError);
    expect(world.extractor.requests).toHaveLength(1);
  });

  it("allows the same image again once the first draft was cancelled", async () => {
    const first = await upload();
    await cancelImport(world.as(A), first.id);
    const second = await upload();
    expect(second.id).not.toBe(first.id);
  });

  it("refuses files that are not screenshots, are empty or too large", async () => {
    const reject = (bytes: Uint8Array) =>
      uploadScreenshot(world.as(A), { bytes, source: "web" }).catch((e: unknown) => e);
    expect(await reject(new TextEncoder().encode("hello"))).toMatchObject({
      code: "invalid",
      message: "Upload a PNG, JPEG or WebP screenshot",
    });
    expect(await reject(new Uint8Array(0))).toMatchObject({ code: "invalid" });
    expect(await reject(new Uint8Array(4_000_001))).toMatchObject({
      code: "invalid",
      message: "That file is too large. The limit is 4 MB",
    });
    expect(world.extractor.requests).toHaveLength(0);
    expect(world.storage.objects.size).toBe(0);
  });

  it("limits uploads per person per day", async () => {
    for (let n = 0; n < 5; n += 1) await upload(A, makePng({ seed: 100 + n }));
    await expect(upload(A, makePng({ seed: 200 }))).rejects.toBeInstanceOf(UploadLimitError);
    // Someone else has their own allowance, and the window rolls over after a day.
    await upload(B, makePng({ seed: 201 }));
    world.clock.now = new Date("2026-11-09T10:00:01Z");
    await upload(A, makePng({ seed: 202 }));
    expect(world.extractor.requests).toHaveLength(7);
  });

  it("removes the stored original when saving the draft fails", async () => {
    const original = world.storage.put.bind(world.storage);
    await original("keep/me.png", makePng(), "image/png");
    const bad = world.as(A);
    const broken = {
      ...bad,
      store: { ...bad.store, createDraft: () => Promise.reject(new Error("db down")) },
    };
    await expect(
      uploadScreenshot(broken as typeof bad, { bytes: makePng({ seed: 7 }), source: "web" }),
    ).rejects.toThrow("db down");
    expect([...world.storage.objects.keys()]).toEqual(["keep/me.png"]);
  });
});

describe("when the model cannot read it", () => {
  for (const failure of [
    "refused",
    "max_tokens",
    "malformed",
    "api_error",
    "not_configured",
  ] as const) {
    it(`leaves an empty draft to fill in by hand after ${failure}`, async () => {
      world.extractor.enqueue({ ok: false, model: "claude-haiku-5-5", failure });
      const view = await upload();
      expect(view.status).toBe("draft");
      expect(view.rows).toEqual([]);
      expect(view.extractionError).toBe(failure);
      const added = await world.store(A).addRow(view.id);
      expect(added.rows).toHaveLength(1);
      expect(await ledgerCount()).toBe(0);
    });
  }

  it("treats a picture that is not about payments as an empty draft too", async () => {
    world.extractor.enqueue(ok(extraction([transaction()], { readable: false })));
    const view = await upload();
    expect(view.rows).toEqual([]);
    expect(view.extractionError).toBeNull();
  });
});

describe("review and confirm", () => {
  it("adds the ticked rows to the ledger in one go, with B removed from the Louvre", async () => {
    const view = await upload();
    const edit = unchanged(view);
    const louvre = edit.rows[3];
    if (!louvre) throw new Error("row missing");
    edit.rows[3] = { ...louvre, split: { members: [id(C), id(D)] } };

    const result = await world.store(A).confirm(view.id, edit);
    expect(result.added).toBe(true);
    expect(result.expenseIds).toHaveLength(4);
    expect(result.unpriced).toBe(0);

    const expenses = await storeFor(db, seed).listExpenses();
    expect(expenses).toHaveLength(4);
    expect(expenses.every((e) => e.importId === view.id)).toBe(true);
    const owes = new Map<string, number>();
    for (const expense of expenses) {
      expect(expense.payers).toEqual([{ userId: id(A), amountMinor: expense.amountMinor }]);
      for (const share of expense.shares) {
        owes.set(share.userId, (owes.get(share.userId) ?? 0) + share.amountMinor);
      }
    }
    // The design's example: B 28.17, C 60.17, D 60.15 (14849 minor units in all), A owes nothing.
    expect(owes.get(id(A))).toBeUndefined();
    expect(owes.get(id(B))).toBe(2817);
    expect(owes.get(id(C))).toBe(6017);
    expect(owes.get(id(D))).toBe(6015);
    const louvreExpense = expenses.find((e) => e.description === "Louvre");
    expect(louvreExpense?.shares.map((x) => x.userId)).toEqual([id(C), id(D)]);

    const after = await world.store(A).getDraft(view.id);
    expect(after?.status).toBe("confirmed");
    expect(after?.expenses).toHaveLength(4);
    expect(after?.confirmedAt).not.toBeNull();
  });

  it("writes an audit entry for every expense and one for the import", async () => {
    const view = await upload();
    await world.store(A).confirm(view.id, unchanged(view));
    const log = await db.select().from(s.auditLog).where(eq(s.auditLog.groupId, seed.groupId));
    expect(log.filter((row) => row.action === "expense.create")).toHaveLength(4);
    const importRows = log.filter((row) => row.action === "import.confirm");
    expect(importRows).toHaveLength(1);
    expect(importRows[0]).toMatchObject({
      entityType: "import",
      entityId: view.id,
      actorUserId: id(A),
    });
    expect(importRows[0]?.after).toMatchObject({ count: 4 });
  });

  it("can switch the payer's own share on, change the payer and use several payers", async () => {
    const view = await upload();
    const edit: DraftEdit = {
      ...unchanged(view),
      batch: { ...view.batch, payerIds: [id(A), id(B)], includePayers: true },
    };
    await world.store(A).confirm(view.id, edit);
    const [first] = await storeFor(db, seed).listExpenses();
    expect(first?.payers.map((p) => p.userId)).toEqual([id(A), id(B)]);
    expect(first?.shares).toHaveLength(4);
  });

  it("supports percentages for a row", async () => {
    const view = await upload();
    const edit = unchanged(view);
    const row = edit.rows[0];
    if (!row) throw new Error("row missing");
    edit.rows[0] = {
      ...row,
      split: { mode: "percent", percents: { [id(B)]: 7000, [id(C)]: 3000 } },
    };
    await world.store(A).confirm(view.id, edit);
    const expense = (await storeFor(db, seed).listExpenses()).find(
      (e) => e.description === "Trattoria Roma",
    );
    expect(expense?.splitMethod).toBe("percent");
    expect(expense?.shares.map((x) => [x.userId, x.amountMinor, x.weight])).toEqual([
      [id(B), 3395, 7000],
      [id(C), 1455, 3000],
    ]);
  });

  it("is idempotent: confirming again adds nothing", async () => {
    const view = await upload();
    const first = await world.store(A).confirm(view.id, unchanged(view));
    const second = await world.store(A).confirm(view.id, unchanged(view));
    expect(second.added).toBe(false);
    expect([...second.expenseIds].sort()).toEqual([...first.expenseIds].sort());
    expect(await ledgerCount()).toBe(4);
  });

  it("is idempotent under concurrent confirms", async () => {
    const view = await upload();
    const results = await Promise.allSettled([
      world.store(A).confirm(view.id, unchanged(view)),
      world.store(A).confirm(view.id, unchanged(view)),
      world.store(A).confirm(view.id, unchanged(view)),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await ledgerCount()).toBe(4);
    const imports = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, "import.confirm"));
    expect(imports).toHaveLength(1);
  });

  it("only lets the uploader change, confirm, undo or discard", async () => {
    const view = await upload();
    const other = world.store(B);
    await expect(other.confirm(view.id, unchanged(view))).rejects.toBeInstanceOf(NotUploaderError);
    await expect(other.saveDraft(view.id, unchanged(view))).rejects.toBeInstanceOf(
      NotUploaderError,
    );
    await expect(other.addRow(view.id)).rejects.toBeInstanceOf(NotUploaderError);
    await expect(other.cancel(view.id)).rejects.toBeInstanceOf(NotUploaderError);
    await expect(other.beginReread(view.id)).rejects.toBeInstanceOf(NotUploaderError);
    expect(await ledgerCount()).toBe(0);
    // They can look at it, though.
    expect((await other.getDraft(view.id))?.rows).toHaveLength(4);

    await world.store(A).confirm(view.id, unchanged(view));
    await expect(other.undo(view.id)).rejects.toBeInstanceOf(NotUploaderError);
    await expect(other.confirm(view.id, unchanged(view))).rejects.toBeInstanceOf(NotUploaderError);
    expect(await ledgerCount()).toBe(4);
  });

  it("does not let another group see or touch it", async () => {
    const view = await upload();
    const stranger = await seedGroup(db);
    const strangerStore = buildWorld(db, stranger).store(A);
    expect(await strangerStore.getDraft(view.id)).toBeNull();
    expect(await strangerStore.imageInfo(view.id)).toBeNull();
    expect(await strangerStore.findActiveByHash("0".repeat(64))).toBeNull();
    await expect(strangerStore.confirm(view.id, unchanged(view))).rejects.toBeInstanceOf(
      ImportNotFoundError,
    );
    await expect(strangerStore.cancel(view.id)).rejects.toBeInstanceOf(ImportNotFoundError);
    await expect(strangerStore.undo(view.id)).rejects.toBeInstanceOf(ImportNotFoundError);
    expect(await strangerStore.listRecent()).toEqual([]);
    expect(await ledgerCount()).toBe(0);
  });

  it("refuses ids that are not UUIDs as not found", async () => {
    const store = world.store(A);
    expect(await store.getDraft("nope")).toBeNull();
    expect(await store.imageInfo("nope")).toBeNull();
    await expect(store.cancel("nope")).rejects.toBeInstanceOf(ImportNotFoundError);
    await expect(
      store.confirm("nope", { batch: (await upload()).batch, rows: [] }),
    ).rejects.toBeInstanceOf(ImportNotFoundError);
  });

  it("blocks Confirm while a ticked row still needs input, and allows it when that row is unticked", async () => {
    world.extractor.enqueue(
      ok(
        extraction([
          transaction(),
          transaction({
            merchant: "Kiosk",
            date: null,
            date_confidence: "unreadable",
            amount_text: "€3,00",
            amount_value: "3.00",
          }),
        ]),
      ),
    );
    const view = await upload();
    expect(view.rows[1]?.included).toBe(false);
    expect(view.rows[1]?.fieldStates.date).toBe("unreadable");

    const ticked = unchanged(view);
    ticked.rows[1] = { ...(ticked.rows[1] ?? rowToEdit(view.rows[1]!)), included: true };
    const error = await world
      .store(A)
      .confirm(view.id, ticked)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DraftInvalidError);
    expect((error as DraftInvalidError).errors[view.rows[1]?.id ?? ""]).toMatchObject({
      date: "Pick a valid date",
    });
    expect(await ledgerCount()).toBe(0);

    // Fill the date in and it goes through.
    ticked.rows[1] = { ...ticked.rows[1], date: "2026-11-04" };
    const done = await world.store(A).confirm(view.id, ticked);
    expect(done.expenseIds).toHaveLength(2);
  });

  it("adds only the unreadable-free rows when the unreadable one stays unticked", async () => {
    world.extractor.enqueue(
      ok(
        extraction([
          transaction(),
          transaction({ merchant: null, merchant_confidence: "unreadable" }),
        ]),
      ),
    );
    const view = await upload();
    const done = await world.store(A).confirm(view.id, unchanged(view));
    expect(done.expenseIds).toHaveLength(1);
  });

  it("needs at least one ticked row, and a split that adds up", async () => {
    const view = await upload();
    const none = unchanged(view);
    none.rows = none.rows.map((r) => ({ ...r, included: false }));
    await expect(world.store(A).confirm(view.id, none)).rejects.toThrow(
      "Tick at least one row to add",
    );

    const bad = unchanged(view);
    bad.rows[0] = { ...(bad.rows[0] ?? rowToEdit(view.rows[0]!)), split: { members: [] } };
    await expect(world.store(A).confirm(view.id, bad)).rejects.toBeInstanceOf(DraftInvalidError);
    expect(await ledgerCount()).toBe(0);
  });

  it("adds an expense without a stored rate when none can be fetched, and says so", async () => {
    world.extractor.enqueue(
      ok(
        extraction([
          transaction({ amount_text: "SEK 100,00", amount_value: "100.00", currency: "SEK" }),
        ]),
      ),
    );
    const view = await upload();
    const result = await world.store(A).confirm(view.id, unchanged(view));
    expect(result.unpriced).toBe(1);
    expect(await ledgerCount()).toBe(1);
  });

  it("saves edits without confirming and keeps them", async () => {
    const view = await upload();
    const edit = unchanged(view);
    edit.rows[0] = {
      ...(edit.rows[0] ?? rowToEdit(view.rows[0]!)),
      merchant: "Trattoria Bella",
      amount: "50.00",
      included: false,
    };
    edit.batch = { ...edit.batch, includePayers: true };
    const saved = await world.store(A).saveDraft(view.id, edit);
    expect(saved.rows[0]).toMatchObject({
      merchant: "Trattoria Bella",
      amountMinor: 5000,
      included: false,
    });
    expect(saved.rows[0]?.fieldStates.amount).toBe("clear");
    expect(saved.batch.includePayers).toBe(true);
    expect((await world.store(A).getDraft(view.id))?.rows[0]?.merchant).toBe("Trattoria Bella");
    expect(await ledgerCount()).toBe(0);
  });

  it("keeps payers to real members", async () => {
    const view = await upload();
    const saved = await world.store(A).saveDraft(view.id, {
      ...unchanged(view),
      batch: { ...view.batch, payerIds: ["not-a-member"] },
    });
    expect(saved.batch.payerIds).toEqual([id(A)]);
  });
});

describe("cancel and expiry", () => {
  it("cancel leaves the ledger unchanged, discards the rows and deletes the original", async () => {
    const view = await upload();
    await cancelImport(world.as(A), view.id);
    const after = await world.store(A).getDraft(view.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.rows).toEqual([]);
    expect(await ledgerCount()).toBe(0);
    expect(world.storage.objects.size).toBe(0);
    expect(after?.imageAvailable).toBe(false);
    // Cancelling again is harmless; confirming a cancelled draft is refused.
    await cancelImport(world.as(A), view.id);
    await expect(world.store(A).confirm(view.id, unchanged(view))).rejects.toBeInstanceOf(
      ImportConflictError,
    );
  });

  it("leaves the original for the retention job when storage is down at cancel", async () => {
    const view = await upload();
    world.storage.failDeletes = true;
    await cancelImport(world.as(A), view.id);
    expect(world.storage.objects.size).toBe(1);
    expect((await world.store(A).getDraft(view.id))?.status).toBe("cancelled");
  });

  it("cannot cancel an import that was already added", async () => {
    const view = await upload();
    await world.store(A).confirm(view.id, unchanged(view));
    await expect(world.store(A).cancel(view.id)).rejects.toBeInstanceOf(ImportConflictError);
  });

  it("expires after 24 hours: it can no longer be edited or confirmed", async () => {
    const view = await upload();
    world.clock.now = new Date("2026-11-09T10:00:01Z");
    const after = await world.store(A).getDraft(view.id);
    expect(after?.status).toBe("expired");
    expect(after?.rows).toEqual([]);
    await expect(world.store(A).confirm(view.id, unchanged(view))).rejects.toBeInstanceOf(
      DraftExpiredError,
    );
    expect(await ledgerCount()).toBe(0);
    // The image is free to upload again.
    expect((await upload()).status).toBe("draft");
  });

  it("refuses to confirm a draft whose time ran out even before anyone looked at it", async () => {
    const view = await upload();
    world.clock.now = new Date("2026-11-09T10:00:01Z");
    await expect(world.store(A).saveDraft(view.id, unchanged(view))).rejects.toBeInstanceOf(
      DraftExpiredError,
    );
  });
});

describe("possible duplicates", () => {
  it("flags and unticks a row that matches an expense already in the ledger", async () => {
    await storeFor(db, seed).createExpense(
      (await import("./ledger-support")).expenseInput(seed, {
        description: "Trattoria Roma",
        amount: "48.50",
        spentOn: "2026-11-03",
      }),
    );
    const view = await upload();
    const flagged = view.rows[0];
    expect(flagged?.included).toBe(false);
    expect(flagged?.issues).toContain("possible_duplicate");
    expect(flagged?.duplicateOf).toMatchObject({ kind: "expense" });
    expect(flagged?.duplicateOf?.label).toContain("Trattoria Roma");
    expect(view.rows.slice(1).every((r) => r.included)).toBe(true);
    // Nothing is dropped: the row is still there and can be ticked.
    const edit = unchanged(view);
    edit.rows[0] = { ...(edit.rows[0] ?? rowToEdit(view.rows[0]!)), included: true };
    const done = await world.store(A).confirm(view.id, edit);
    expect(done.expenseIds).toHaveLength(4);
  });

  it("flags rows that repeat another open draft (overlapping scrolled screenshots)", async () => {
    const first = await upload(A, makePng({ seed: 31 }));
    expect(first.rows.every((r) => r.included)).toBe(true);
    world.extractor.enqueue(
      ok(
        extraction([
          transaction({
            merchant: "Louvre",
            date: "2026-11-04",
            amount_text: "€64,00",
            amount_value: "64.00",
          }),
          transaction({ merchant: "Gelato", amount_text: "€4,00", amount_value: "4.00" }),
        ]),
      ),
    );
    const second = await upload(B, makePng({ seed: 32 }));
    expect(second.rows[0]?.duplicateOf).toMatchObject({ kind: "draft", importId: first.id });
    expect(second.rows[0]?.included).toBe(false);
    expect(second.rows[1]?.included).toBe(true);
  });

  it("does not count two identical rows of the same screenshot as duplicates of each other", async () => {
    world.extractor.enqueue(ok(extraction([transaction(), transaction()])));
    const view = await upload();
    expect(view.rows.every((r) => r.included && r.duplicateOf === null)).toBe(true);
  });
});

describe("undo import", () => {
  it("reverses the whole batch and writes the audit trail", async () => {
    const view = await upload();
    await world.store(A).confirm(view.id, unchanged(view));
    expect(await ledgerCount()).toBe(4);

    const result = await world.store(A).undo(view.id);
    expect(result.expenseIds).toHaveLength(4);
    expect(await ledgerCount()).toBe(0);
    const deleted = await storeFor(db, seed).listExpenses({ deleted: true });
    expect(deleted).toHaveLength(4);
    expect((await world.store(A).getDraft(view.id))?.status).toBe("undone");

    const log = await db.select().from(s.auditLog).where(eq(s.auditLog.groupId, seed.groupId));
    expect(log.filter((row) => row.action === "expense.delete")).toHaveLength(4);
    expect(log.filter((row) => row.action === "import.undo")).toHaveLength(1);
    // Balances are back to nothing.
    const ledger = await storeFor(db, seed).loadLedger();
    expect(ledger.expenses).toEqual([]);
  });

  it("is idempotent and only works on an added import", async () => {
    const view = await upload();
    await expect(world.store(A).undo(view.id)).rejects.toBeInstanceOf(ImportConflictError);
    await world.store(A).confirm(view.id, unchanged(view));
    await world.store(A).undo(view.id);
    expect(await world.store(A).undo(view.id)).toEqual({ expenseIds: [] });
  });

  it("skips expenses that were already deleted by hand", async () => {
    const view = await upload();
    const done = await world.store(A).confirm(view.id, unchanged(view));
    await storeFor(db, seed).deleteExpense(done.expenseIds[0] ?? "");
    expect((await world.store(A).undo(view.id)).expenseIds).toHaveLength(3);
  });

  it("lets the same image be imported again afterwards", async () => {
    const view = await upload();
    await world.store(A).confirm(view.id, unchanged(view));
    await expect(upload()).rejects.toBeInstanceOf(DuplicateImageError);
    await world.store(A).undo(view.id);
    expect((await upload()).status).toBe("draft");
  });
});

describe("re-read with the stronger model", () => {
  it("replaces the rows with the stronger reading and keeps the batch choices", async () => {
    const view = await upload();
    await world.store(A).saveDraft(view.id, {
      ...unchanged(view),
      batch: { ...view.batch, includePayers: true },
    });
    world.extractor.enqueue(
      ok(
        extraction([
          transaction({
            merchant: "Trattoria Roma (corrected)",
            amount_text: "€48,60",
            amount_value: "48.60",
          }),
        ]),
        "claude-sonnet-5-5",
      ),
    );
    const { view: after, failed } = await rereadScreenshot(world.as(A), view.id);
    expect(failed).toBe(false);
    expect(world.extractor.requests[1]?.model).toBe("claude-sonnet-5-5");
    expect(after.model).toBe("claude-sonnet-5-5");
    expect(after.rereads).toBe(1);
    expect(after.rows.map((r) => r.merchant)).toEqual(["Trattoria Roma (corrected)"]);
    expect(after.batch.includePayers).toBe(true);
  });

  it("leaves the draft exactly as it was when the second read fails", async () => {
    const view = await upload();
    world.extractor.enqueue({ ok: false, model: "claude-sonnet-5-5", failure: "refused" });
    const { view: after, failed } = await rereadScreenshot(world.as(A), view.id);
    expect(failed).toBe(true);
    expect(after.rows).toHaveLength(4);
    expect(after.model).toBe("claude-haiku-5-5");
  });

  it("is limited to two re-reads, needs the original and is uploader only", async () => {
    const view = await upload();
    await rereadScreenshot(world.as(A), view.id);
    await rereadScreenshot(world.as(A), view.id);
    await expect(rereadScreenshot(world.as(A), view.id)).rejects.toBeInstanceOf(RereadLimitError);
    await expect(rereadScreenshot(world.as(B), view.id)).rejects.toBeInstanceOf(NotUploaderError);

    const other = await upload(A, makePng({ seed: 77 }));
    world.storage.objects.clear();
    await expect(rereadScreenshot(world.as(A), other.id)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("listing", () => {
  it("shows recent imports with their row counts, newest first", async () => {
    const first = await upload(A, makePng({ seed: 51 }));
    world.clock.now = new Date("2026-11-08T11:00:00Z");
    world.extractor.enqueue(
      ok(
        extraction([
          transaction({ merchant: "Gelato", amount_text: "€4,00", amount_value: "4.00" }),
        ]),
      ),
    );
    const second = await upload(B, makePng({ seed: 52 }));
    const list = await world.store(C).listRecent();
    expect(list.map((x) => x.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({
      rowCount: 1,
      includedCount: 1,
      status: "draft",
      uploaderId: id(B),
    });
    world.clock.now = new Date("2026-11-20T11:00:00Z");
    expect((await world.store(C).listRecent()).map((x) => [x.status, x.rowCount])).toEqual([
      ["expired", 0],
      ["expired", 0],
    ]);
  });
});

describe("image access", () => {
  it("is available to every member of the group while the original is stored", async () => {
    const view = await upload();
    expect(await world.store(D).imageInfo(view.id)).toMatchObject({ mediaType: "image/png" });
    await world.store(A).markImageDeleted(view.id);
    expect(await world.store(D).imageInfo(view.id)).toBeNull();
  });
});

describe("the database agrees", () => {
  it("keeps a draft's rows out of expenses until confirm", async () => {
    const view = await upload();
    const rows = await db.select().from(s.importRows).where(eq(s.importRows.importId, view.id));
    expect(rows).toHaveLength(4);
    const linked = await db
      .select()
      .from(s.expenses)
      .where(and(eq(s.expenses.groupId, seed.groupId)));
    expect(linked).toEqual([]);
  });

  it("is a typed error for anything else", () => {
    expect(new ImportError("invalid", "x").code).toBe("invalid");
    expect(wireframeExtraction().transactions).toHaveLength(4);
  });
});

export type { DraftView };
