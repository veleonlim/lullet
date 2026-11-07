import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import type { Session } from "@/lib/auth/session";
import {
  applyEdit,
  cleanBatch,
  draftExpiry,
  draftEditSchema,
  findDuplicate,
  isExtractionFailure,
  normalizeExtraction,
  rowSplitOverrideSchema,
  validateForConfirm,
  batchSplitSchema,
  type BatchSplit,
  type ConfirmResult,
  type DraftEdit,
  type DraftRow,
  type DraftRowSeed,
  type DraftView,
  type DuplicateCandidate,
  type DuplicateRef,
  type ImportStatus,
  type ImportSummary,
} from "@/lib/import";
import { MAX_REREADS } from "@/lib/import/policy";
import { isCategoryId } from "@/lib/ledger/categories";
import { addDays } from "@/lib/import/days";
import { isCurrencyCode } from "@/lib/money";
import { createLedgerKit, type LedgerKit, type StoreOptions } from "@/server/ledger";
import {
  DraftExpiredError,
  DraftInvalidError,
  DuplicateImageError,
  ImageGoneError,
  ImportConflictError,
  ImportNotFoundError,
  NotUploaderError,
  RereadLimitError,
} from "./errors";
import type { ExtractionOutcome } from "./extract/types";

/**
 * Data access for screenshot imports. Like the ledger store it is created from the caller's
 * session and every query is filtered by that session's group; drafts live in their own tables
 * and never reach balances. Adding a batch to the ledger and reversing it each happen in one
 * transaction, through the ledger's own insert and delete so every expense gets its audit row.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

export interface NewDraft {
  /** Chosen by the caller so the stored image can be named after it. */
  readonly importId: string;
  readonly source: "web" | "telegram";
  readonly imageSha256: string;
  readonly storageKey: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly caption?: string | null;
  readonly outcome: ExtractionOutcome;
  /** Today's calendar day, for the future date check. */
  readonly today: string;
}

export interface ImageInfo {
  readonly storageKey: string;
  readonly mediaType: string;
}

export interface ImportStore {
  readonly session: Session;
  /** The group's members in their fixed order. */
  members(): ReturnType<LedgerKit["store"]["members"]>;
  /** Uploads by the caller since `since`, for the daily limit. */
  countUploadsSince(since: Date): Promise<number>;
  /** A draft or confirmed import of the same image in the caller's group. */
  findActiveByHash(sha256: string): Promise<{ id: string; status: ImportStatus } | null>;
  createDraft(input: NewDraft): Promise<{ id: string }>;
  /** Null when it does not exist in the caller's group. A draft past its time is expired on the way. */
  getDraft(id: string): Promise<DraftView | null>;
  listRecent(limit?: number): Promise<ImportSummary[]>;
  /** Saves the person's edits to an open draft (uploader only). */
  saveDraft(id: string, edit: DraftEdit): Promise<DraftView>;
  /** A blank row to type a transaction into by hand (uploader only). */
  addRow(id: string): Promise<DraftView>;
  /** Adds the ticked rows to the ledger in one transaction. Idempotent (uploader only). */
  confirm(id: string, edit: DraftEdit): Promise<ConfirmResult>;
  /** Discards an open draft. Returns where the original is stored so it can be deleted (uploader only). */
  cancel(id: string): Promise<{ storageKey: string | null }>;
  /** Reverses a confirmed import: soft deletes its expenses in one transaction (uploader only). */
  undo(id: string): Promise<{ expenseIds: string[] }>;
  /** Counts a re-read and says where the original is; throws when it is not allowed (uploader only). */
  beginReread(id: string): Promise<ImageInfo>;
  /** Replaces the rows with a fresh read. A failed read changes nothing. */
  applyReread(id: string, outcome: ExtractionOutcome, today: string): Promise<DraftView>;
  /** Where the original is, for showing it to a member of the group. */
  imageInfo(id: string): Promise<ImageInfo | null>;
  /** Forgets a stored original after it was deleted from storage. */
  markImageDeleted(id: string): Promise<void>;
}

const fieldStatesSchema = z.record(
  z.enum(["merchant", "date", "amount", "currency", "category"]),
  z.enum(["clear", "uncertain", "guessed", "unreadable"]),
);
const duplicateRefSchema = z.object({
  kind: z.enum(["expense", "draft"]),
  id: z.string(),
  importId: z.string().nullable(),
  label: z.string(),
});

function defaultBatch(uploaderId: string): BatchSplit {
  return { payerIds: [uploaderId], includePayers: false, mode: "equal", percents: null };
}

function parseBatch(value: unknown, uploaderId: string): BatchSplit {
  const parsed = batchSplitSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultBatch(uploaderId);
}

type RowRecord = typeof s.importRows.$inferSelect;
type ImportRecord = typeof s.imports.$inferSelect;

function toDraftRow(row: RowRecord): DraftRow {
  const states = fieldStatesSchema.safeParse(row.fieldStates);
  const duplicate = duplicateRefSchema.safeParse(row.duplicateOf);
  const split = rowSplitOverrideSchema.safeParse(row.draftSplit);
  return {
    id: row.id,
    position: row.position,
    merchant: row.merchant,
    dateText: row.dateText,
    spentOn: row.spentOn,
    amountText: row.amountText,
    amountMinor: row.amountMinor,
    currency: row.currency !== null && isCurrencyCode(row.currency) ? row.currency : null,
    billedAmountText: row.billedAmountText,
    billedAmountMinor: row.billedAmountMinor,
    billedCurrency:
      row.billedCurrency !== null && isCurrencyCode(row.billedCurrency) ? row.billedCurrency : null,
    category: isCategoryId(row.category) ? row.category : "other",
    categoryConfidence: row.categoryConfidence ?? 0,
    included: row.included,
    issues: row.issues,
    fieldStates: states.success ? states.data : {},
    duplicateOf: duplicate.success ? duplicate.data : null,
    split: split.success && row.draftSplit !== null ? split.data : null,
  };
}

function rowValues(importId: string, row: DraftRow) {
  return {
    importId,
    position: row.position,
    merchant: row.merchant,
    dateText: row.dateText,
    amountText: row.amountText,
    amountMinor: row.amountMinor,
    currency: row.currency,
    billedAmountText: row.billedAmountText,
    billedAmountMinor: row.billedAmountMinor,
    billedCurrency: row.billedCurrency,
    spentOn: row.spentOn,
    category: row.category,
    categoryConfidence: row.categoryConfidence,
    included: row.included,
    issues: [...row.issues],
    fieldStates: row.fieldStates,
    duplicateOf: row.duplicateOf,
    draftSplit: row.split,
  };
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
}

export function createImportStore(options: StoreOptions): ImportStore {
  const kit: LedgerKit = createLedgerKit(options);
  const { db } = options;
  const { session } = kit;
  const now = kit.now;
  const groupId = session.groupId;

  let orderPromise: Promise<string[]> | undefined;
  /** The group's members in their fixed order; also proves the caller belongs to the group. */
  function memberOrder(): Promise<string[]> {
    orderPromise ??= kit.store.members().then((members) => members.map((m) => m.userId));
    return orderPromise;
  }

  function assertId(id: string): void {
    if (!UUID.test(id)) throw new ImportNotFoundError();
  }

  async function readImport(
    executor: Executor,
    id: string,
    lock = false,
  ): Promise<ImportRecord | null> {
    const query = executor
      .select()
      .from(s.imports)
      .where(and(eq(s.imports.groupId, groupId), eq(s.imports.id, id)));
    const [row] = await (lock ? query.for("update") : query);
    return row ?? null;
  }

  async function readRows(executor: Executor, importId: string): Promise<DraftRow[]> {
    const rows = await executor
      .select()
      .from(s.importRows)
      .where(eq(s.importRows.importId, importId))
      .orderBy(asc(s.importRows.position));
    return rows.map(toDraftRow);
  }

  /** Throws unless the caller uploaded the import. */
  function requireUploader(record: ImportRecord): void {
    if (record.uploaderId !== session.userId) throw new NotUploaderError();
  }

  /** Expires a draft whose time is up and discards its rows. Returns the (possibly changed) record. */
  async function expireIfDue(executor: Executor, record: ImportRecord): Promise<ImportRecord> {
    if (record.status !== "draft" || record.expiresAt === null || record.expiresAt > now()) {
      return record;
    }
    await executor.delete(s.importRows).where(eq(s.importRows.importId, record.id));
    const [updated] = await executor
      .update(s.imports)
      .set({ status: "expired" })
      .where(and(eq(s.imports.id, record.id), eq(s.imports.status, "draft")))
      .returning();
    return updated ?? { ...record, status: "expired" };
  }

  async function toView(executor: Executor, record: ImportRecord): Promise<DraftView> {
    const rows =
      record.status === "cancelled" || record.status === "expired"
        ? []
        : await readRows(executor, record.id);
    const expenses =
      record.status === "confirmed" || record.status === "undone"
        ? await kit.store.listImportExpenses(record.id)
        : [];
    return {
      id: record.id,
      status: record.status,
      uploaderId: record.uploaderId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      confirmedAt: record.confirmedAt,
      undoneAt: record.undoneAt,
      model: record.model,
      extractionError: isExtractionFailure(record.extractionError) ? record.extractionError : null,
      rereads: record.rereads,
      notes: record.notes,
      screenTotal:
        record.screenTotalText === null
          ? null
          : {
              text: record.screenTotalText,
              minor: record.screenTotalMinor,
              currency: record.screenTotalCurrency,
            },
      batch: parseBatch(record.draft, record.uploaderId),
      rows,
      imageAvailable: record.storageKey !== null && record.imageDeletedAt === null,
      expenses,
    };
  }

  /** Existing expenses and rows of other open drafts that a new draft's rows might repeat. */
  async function duplicateCandidates(
    executor: Executor,
    seeds: readonly { spentOn: string | null }[],
    exceptImportId: string,
  ): Promise<DuplicateCandidate[]> {
    const days = seeds
      .map((seed) => seed.spentOn)
      .filter((day): day is string => day !== null)
      .sort();
    const first = days[0];
    const last = days[days.length - 1];
    if (first === undefined || last === undefined) return [];

    const expenses = await kit.store.listExpenses();
    const candidates: DuplicateCandidate[] = expenses
      .filter((e) => e.spentOn >= addDays(first, -1) && e.spentOn <= addDays(last, 1))
      .map((e) => ({
        kind: "expense" as const,
        id: e.id,
        importId: e.importId ?? null,
        merchant: e.description,
        spentOn: e.spentOn,
        amountMinor: e.amountMinor,
        currency: e.currency,
        billedAmountMinor: e.billedAmountMinor,
        billedCurrency: e.billedCurrency,
        payerIds: e.payers.map((p) => p.userId),
      }));

    const drafts = await executor
      .select({ row: s.importRows, uploaderId: s.imports.uploaderId, batch: s.imports.draft })
      .from(s.importRows)
      .innerJoin(s.imports, eq(s.imports.id, s.importRows.importId))
      .where(
        and(
          eq(s.imports.groupId, groupId),
          eq(s.imports.status, "draft"),
          gt(s.imports.expiresAt, now()),
          sql`${s.imports.id} <> ${exceptImportId}`,
          gte(s.importRows.spentOn, addDays(first, -1)),
          lte(s.importRows.spentOn, addDays(last, 1)),
        ),
      );
    for (const { row, uploaderId, batch } of drafts) {
      if (
        row.merchant === null ||
        row.spentOn === null ||
        row.amountMinor === null ||
        row.currency === null
      ) {
        continue;
      }
      candidates.push({
        kind: "draft",
        id: row.id,
        importId: row.importId,
        merchant: row.merchant,
        spentOn: row.spentOn,
        amountMinor: row.amountMinor,
        currency: row.currency,
        billedAmountMinor: row.billedAmountMinor,
        billedCurrency: row.billedCurrency,
        payerIds: parseBatch(batch, uploaderId).payerIds,
      });
    }
    return candidates;
  }

  /** Marks rows that look like something already recorded: unchecked, never dropped. */
  function flagDuplicates(
    seeds: readonly DraftRowSeed[],
    candidates: readonly DuplicateCandidate[],
    payerIds: readonly string[],
  ): { seed: DraftRowSeed; duplicateOf: DuplicateRef | null }[] {
    return seeds.map((seed) => {
      const match = findDuplicate(
        {
          merchant: seed.merchant,
          spentOn: seed.spentOn,
          amountMinor: seed.amountMinor,
          currency: seed.currency,
          billedAmountMinor: seed.billedAmountMinor,
          billedCurrency: seed.billedCurrency,
        },
        candidates,
        payerIds,
      );
      if (!match) return { seed, duplicateOf: null };
      const { candidate } = match;
      return {
        seed: {
          ...seed,
          included: false,
          issues: [...seed.issues, "possible_duplicate"],
        },
        duplicateOf: {
          kind: candidate.kind,
          id: candidate.id,
          importId: candidate.importId,
          label: `${candidate.merchant}, ${candidate.spentOn}`,
        },
      };
    });
  }

  function seedToRow(
    seed: DraftRowSeed,
    position: number,
    duplicateOf: DuplicateRef | null,
  ): DraftRow {
    return { ...seed, id: "", position, duplicateOf, split: null };
  }

  async function plan(
    outcome: ExtractionOutcome,
    today: string,
    exceptImportId: string,
    executor: Executor,
  ) {
    if (!outcome.ok) {
      return {
        rows: [] as { seed: DraftRowSeed; duplicateOf: DuplicateRef | null }[],
        total: null,
        notes: [] as string[],
      };
    }
    const normalized = normalizeExtraction(outcome.extraction, today);
    const candidates = await duplicateCandidates(executor, normalized.rows, exceptImportId);
    return {
      rows: flagDuplicates(normalized.rows, candidates, [session.userId]),
      total: normalized.screenTotal,
      notes: [...normalized.notes],
    };
  }

  /** Locks an import and checks the caller may change it while it is still a draft. */
  async function lockOpenDraft(tx: Tx, id: string): Promise<ImportRecord> {
    assertId(id);
    const found = await readImport(tx, id, true);
    if (!found) throw new ImportNotFoundError();
    requireUploader(found);
    const record = await expireIfDue(tx, found);
    if (record.status === "expired") throw new DraftExpiredError();
    if (record.status !== "draft") {
      throw new ImportConflictError(
        record.status === "cancelled"
          ? "This draft was discarded"
          : "This import was already added to the ledger",
      );
    }
    return record;
  }

  /** Applies the person's edits to the stored rows and batch choices inside the transaction. */
  async function saveEdits(
    tx: Tx,
    record: ImportRecord,
    edit: DraftEdit,
    order: readonly string[],
  ): Promise<{ rows: DraftRow[]; batch: BatchSplit }> {
    const batch = cleanBatch(edit.batch, order, record.uploaderId);
    const stored = await readRows(tx, record.id);
    const byId = new Map(edit.rows.map((row) => [row.id, row] as const));
    const rows: DraftRow[] = [];
    for (const row of stored) {
      const change = byId.get(row.id);
      const next = change ? applyEdit(row, change) : row;
      rows.push(next);
      if (next !== row) {
        await tx
          .update(s.importRows)
          .set(rowValues(record.id, next))
          .where(eq(s.importRows.id, row.id));
      }
    }
    await tx.update(s.imports).set({ draft: batch }).where(eq(s.imports.id, record.id));
    return { rows, batch };
  }

  /** Like `lockOpenDraft` but lets an already confirmed import through (confirm is idempotent). */
  async function lockOpenDraftOrConfirmed(tx: Tx, id: string): Promise<ImportRecord> {
    const found = await readImport(tx, id, true);
    if (!found) throw new ImportNotFoundError();
    requireUploader(found);
    if (found.status === "confirmed") return found;
    return lockOpenDraft(tx, id);
  }

  async function findActiveByHash(
    sha256: string,
  ): Promise<{ id: string; status: ImportStatus } | null> {
    await memberOrder();
    const [row] = await db
      .select({ id: s.imports.id, status: s.imports.status, expiresAt: s.imports.expiresAt })
      .from(s.imports)
      .where(
        and(
          eq(s.imports.groupId, groupId),
          eq(s.imports.imageSha256, sha256),
          inArray(s.imports.status, ["draft", "confirmed"]),
        ),
      )
      .limit(1);
    if (!row) return null;
    // A draft whose time is up no longer holds the image.
    if (row.status === "draft" && row.expiresAt !== null && row.expiresAt <= now()) {
      const record = await readImport(db, row.id);
      if (record) await expireIfDue(db, record);
      return null;
    }
    return { id: row.id, status: row.status };
  }

  async function viewAfter(id: string): Promise<DraftView> {
    const record = await readImport(db, id);
    if (!record) throw new ImportNotFoundError();
    return toView(db, record);
  }

  return {
    session,
    members: () => kit.store.members(),

    async countUploadsSince(since) {
      await memberOrder();
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(s.imports)
        .where(
          and(
            eq(s.imports.groupId, groupId),
            eq(s.imports.uploaderId, session.userId),
            gte(s.imports.createdAt, since),
          ),
        );
      return row?.count ?? 0;
    },

    findActiveByHash,

    async createDraft(input) {
      await memberOrder();
      const built = await plan(input.outcome, input.today, input.importId, db);
      const at = now();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(s.imports).values({
            id: input.importId,
            groupId,
            uploaderId: session.userId,
            source: input.source,
            status: "draft",
            imageSha256: input.imageSha256,
            storageKey: input.storageKey,
            mediaType: input.mediaType,
            byteSize: input.byteSize,
            caption: input.caption ?? null,
            model: input.outcome.model,
            extractionError: input.outcome.ok ? null : input.outcome.failure,
            draft: defaultBatch(session.userId),
            screenTotalText: built.total?.text ?? null,
            screenTotalMinor: built.total?.minor ?? null,
            screenTotalCurrency: built.total?.currency ?? null,
            notes: built.notes,
            createdAt: at,
            expiresAt: draftExpiry(at),
          });
          if (built.rows.length > 0) {
            await tx
              .insert(s.importRows)
              .values(
                built.rows.map(({ seed, duplicateOf }, position) =>
                  rowValues(input.importId, seedToRow(seed, position, duplicateOf)),
                ),
              );
          }
        });
      } catch (error) {
        if (pgCode(error) === UNIQUE_VIOLATION) {
          const existing = await findActiveByHash(input.imageSha256);
          if (existing) throw new DuplicateImageError(existing.id);
        }
        throw error;
      }
      return { id: input.importId };
    },

    async getDraft(id) {
      await memberOrder();
      if (!UUID.test(id)) return null;
      const found = await readImport(db, id);
      if (!found) return null;
      return toView(db, await expireIfDue(db, found));
    },

    async listRecent(limit = 20) {
      await memberOrder();
      const records = await db
        .select()
        .from(s.imports)
        .where(eq(s.imports.groupId, groupId))
        .orderBy(desc(s.imports.createdAt))
        .limit(limit);
      if (records.length === 0) return [];
      const counts = await db
        .select({
          importId: s.importRows.importId,
          rows: sql<number>`count(*)::int`,
          included: sql<number>`count(*) filter (where ${s.importRows.included})::int`,
        })
        .from(s.importRows)
        .where(
          inArray(
            s.importRows.importId,
            records.map((r) => r.id),
          ),
        )
        .groupBy(s.importRows.importId);
      const byImport = new Map(counts.map((c) => [c.importId, c] as const));
      const result: ImportSummary[] = [];
      for (const found of records) {
        const record = await expireIfDue(db, found);
        const count = byImport.get(record.id);
        result.push({
          id: record.id,
          status: record.status,
          uploaderId: record.uploaderId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          rowCount: record.status === "expired" ? 0 : (count?.rows ?? 0),
          includedCount: record.status === "expired" ? 0 : (count?.included ?? 0),
          extractionError: isExtractionFailure(record.extractionError)
            ? record.extractionError
            : null,
        });
      }
      return result;
    },

    async saveDraft(id, edit) {
      const order = await memberOrder();
      draftEditSchema.parse(edit);
      await db.transaction(async (tx) => {
        const record = await lockOpenDraft(tx, id);
        await saveEdits(tx, record, edit, order);
      });
      return viewAfter(id);
    },

    async addRow(id) {
      await memberOrder();
      await db.transaction(async (tx) => {
        const record = await lockOpenDraft(tx, id);
        const [last] = await tx
          .select({ position: s.importRows.position })
          .from(s.importRows)
          .where(eq(s.importRows.importId, record.id))
          .orderBy(desc(s.importRows.position))
          .limit(1);
        const blank: DraftRow = {
          id: "",
          position: (last?.position ?? -1) + 1,
          merchant: null,
          dateText: null,
          spentOn: null,
          amountText: null,
          amountMinor: null,
          currency: null,
          billedAmountText: null,
          billedAmountMinor: null,
          billedCurrency: null,
          category: "other",
          categoryConfidence: 0,
          included: true,
          issues: [],
          fieldStates: {
            merchant: "unreadable",
            date: "unreadable",
            amount: "unreadable",
            currency: "unreadable",
          },
          duplicateOf: null,
          split: null,
        };
        await tx.insert(s.importRows).values(rowValues(record.id, blank));
      });
      return viewAfter(id);
    },

    async confirm(id, edit) {
      const order = await memberOrder();
      draftEditSchema.parse(edit);
      assertId(id);

      // An import that was already confirmed answers with what it added, without doing anything.
      const before = await readImport(db, id);
      if (!before) throw new ImportNotFoundError();
      requireUploader(before);
      if (before.status === "confirmed") {
        const expenses = await kit.store.listImportExpenses(id);
        return { importId: id, expenseIds: expenses.map((e) => e.id), unpriced: 0, added: false };
      }

      // Exchange rates are fetched before the transaction opens (they are a network call).
      const stored = await readRows(db, id);
      const byId = new Map(edit.rows.map((row) => [row.id, row] as const));
      const preview = validateForConfirm(
        stored.map((row) => {
          const change = byId.get(row.id);
          return change ? applyEdit(row, change) : row;
        }),
        cleanBatch(edit.batch, order, before.uploaderId),
        order,
      );
      const unpricedRows = new Set<string>();
      if (preview.ok) {
        for (const { row, input } of preview.rows) {
          const { priced } = await kit.prepareExpense(input);
          if (!priced) unpricedRows.add(row.id);
        }
      }

      return db.transaction(async (tx) => {
        const record = await lockOpenDraftOrConfirmed(tx, id);
        if (record.status === "confirmed") {
          const expenses = await kit.store.listImportExpenses(id);
          return { importId: id, expenseIds: expenses.map((e) => e.id), unpriced: 0, added: false };
        }
        const { rows, batch } = await saveEdits(tx, record, edit, order);
        const checked = validateForConfirm(rows, batch, order);
        if (!checked.ok) throw new DraftInvalidError(checked.message, checked.errors);

        const ids: string[] = [];
        for (const { row, input } of checked.rows) {
          const created = await kit.insertExpense(tx, input, { importId: id, importRowId: row.id });
          ids.push(created.id);
        }
        const at = now();
        await tx
          .update(s.imports)
          .set({ status: "confirmed", confirmedAt: at })
          .where(eq(s.imports.id, id));
        await kit.audit(tx, {
          action: "import.confirm",
          entityType: "import",
          entityId: id,
          before: null,
          after: { expenseIds: ids, count: ids.length },
        });
        const unpriced = checked.rows.filter(({ row }) => unpricedRows.has(row.id)).length;
        return { importId: id, expenseIds: ids, unpriced, added: true };
      });
    },

    async cancel(id) {
      await memberOrder();
      assertId(id);
      return db.transaction(async (tx) => {
        const record = await readImport(tx, id, true);
        if (!record) throw new ImportNotFoundError();
        requireUploader(record);
        if (record.status === "cancelled") return { storageKey: record.storageKey };
        if (record.status !== "draft") {
          throw new ImportConflictError(
            record.status === "expired"
              ? "This draft already expired"
              : "This import was already added. Use Undo import instead.",
          );
        }
        await tx.delete(s.importRows).where(eq(s.importRows.importId, id));
        await tx.update(s.imports).set({ status: "cancelled" }).where(eq(s.imports.id, id));
        await kit.audit(tx, {
          action: "import.cancel",
          entityType: "import",
          entityId: id,
          before: null,
          after: null,
        });
        return { storageKey: record.storageKey };
      });
    },

    async undo(id) {
      await memberOrder();
      assertId(id);
      return db.transaction(async (tx) => {
        const record = await readImport(tx, id, true);
        if (!record) throw new ImportNotFoundError();
        requireUploader(record);
        if (record.status === "undone") return { expenseIds: [] };
        if (record.status !== "confirmed") {
          throw new ImportConflictError("Only an import that was added can be undone");
        }
        const expenses = await kit.store.listImportExpenses(id);
        const live = expenses.filter((e) => e.deletedAt === null);
        for (const expense of live) await kit.deleteExpenseIn(tx, expense.id);
        await tx
          .update(s.imports)
          .set({ status: "undone", undoneAt: now() })
          .where(eq(s.imports.id, id));
        await kit.audit(tx, {
          action: "import.undo",
          entityType: "import",
          entityId: id,
          before: null,
          after: { expenseIds: live.map((e) => e.id), count: live.length },
        });
        return { expenseIds: live.map((e) => e.id) };
      });
    },

    async beginReread(id) {
      await memberOrder();
      return db.transaction(async (tx) => {
        const record = await lockOpenDraft(tx, id);
        if (record.rereads >= MAX_REREADS) throw new RereadLimitError();
        if (
          record.storageKey === null ||
          record.imageDeletedAt !== null ||
          record.mediaType === null
        ) {
          throw new ImageGoneError();
        }
        await tx
          .update(s.imports)
          .set({ rereads: record.rereads + 1 })
          .where(eq(s.imports.id, id));
        return { storageKey: record.storageKey, mediaType: record.mediaType };
      });
    },

    async applyReread(id, outcome, today) {
      await memberOrder();
      // A failed read leaves the draft exactly as it was.
      if (!outcome.ok) return viewAfter(id);
      const built = await plan(outcome, today, id, db);
      await db.transaction(async (tx) => {
        const record = await lockOpenDraft(tx, id);
        await tx.delete(s.importRows).where(eq(s.importRows.importId, id));
        if (built.rows.length > 0) {
          await tx
            .insert(s.importRows)
            .values(
              built.rows.map(({ seed, duplicateOf }, position) =>
                rowValues(id, seedToRow(seed, position, duplicateOf)),
              ),
            );
        }
        await tx
          .update(s.imports)
          .set({
            model: outcome.model,
            extractionError: null,
            screenTotalText: built.total?.text ?? null,
            screenTotalMinor: built.total?.minor ?? null,
            screenTotalCurrency: built.total?.currency ?? null,
            notes: built.notes,
          })
          .where(eq(s.imports.id, record.id));
      });
      return viewAfter(id);
    },

    async imageInfo(id) {
      await memberOrder();
      if (!UUID.test(id)) return null;
      const record = await readImport(db, id);
      if (record?.storageKey == null || record.imageDeletedAt !== null) return null;
      return {
        storageKey: record.storageKey,
        mediaType: record.mediaType ?? "application/octet-stream",
      };
    },

    async markImageDeleted(id) {
      await memberOrder();
      assertId(id);
      await db
        .update(s.imports)
        .set({ storageKey: null, imageDeletedAt: now() })
        .where(and(eq(s.imports.groupId, groupId), eq(s.imports.id, id)));
    },
  };
}
