import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import { retentionCutoff } from "@/lib/import/policy";
import type { ImageStorage } from "./storage/types";

/**
 * The scheduled clean-up, run by a cron job (see `/api/cron/retention`). It is a system job, not
 * a group-scoped request: it works across all groups and acts as nobody.
 *
 *  1. Drafts past their 24 hours are expired and their rows discarded.
 *  2. Originals are deleted 30 days after the import was confirmed (or undone), and straight
 *     away for drafts that were cancelled or expired. The extracted rows always stay.
 *
 * It is safe to run twice, and a failure on one image never stops the rest: that image is tried
 * again on the next run.
 */

const BATCH = 200;

export interface RetentionResult {
  readonly expiredDrafts: number;
  readonly deletedImages: number;
  readonly failedImages: number;
}

export async function runRetention(input: {
  readonly db: Database;
  readonly storage: ImageStorage;
  readonly now?: () => Date;
}): Promise<RetentionResult> {
  const { db, storage } = input;
  const at = (input.now ?? (() => new Date()))();

  const stale = await db
    .select({ id: s.imports.id })
    .from(s.imports)
    .where(and(eq(s.imports.status, "draft"), lte(s.imports.expiresAt, at)))
    .limit(BATCH);
  if (stale.length > 0) {
    const ids = stale.map((row) => row.id);
    await db.transaction(async (tx) => {
      await tx.delete(s.importRows).where(inArray(s.importRows.importId, ids));
      await tx
        .update(s.imports)
        .set({ status: "expired" })
        .where(and(inArray(s.imports.id, ids), eq(s.imports.status, "draft")));
    });
  }

  const due = await db
    .select({
      id: s.imports.id,
      groupId: s.imports.groupId,
      storageKey: s.imports.storageKey,
    })
    .from(s.imports)
    .where(
      and(
        isNotNull(s.imports.storageKey),
        isNull(s.imports.imageDeletedAt),
        or(
          inArray(s.imports.status, ["cancelled", "expired"]),
          and(
            inArray(s.imports.status, ["confirmed", "undone"]),
            lte(s.imports.confirmedAt, retentionCutoff(at)),
          ),
        ),
      ),
    )
    .limit(BATCH);

  let deletedImages = 0;
  let failedImages = 0;
  for (const row of due) {
    if (row.storageKey === null) continue;
    try {
      await storage.delete(row.storageKey);
    } catch {
      failedImages += 1;
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(s.imports)
        .set({ storageKey: null, imageDeletedAt: at })
        .where(eq(s.imports.id, row.id));
      await tx.insert(s.auditLog).values({
        groupId: row.groupId,
        actorUserId: null,
        action: "import.image_deleted",
        entityType: "import",
        entityId: row.id,
        before: null,
        after: null,
      });
    });
    deletedImages += 1;
  }
  return { expiredDrafts: stale.length, deletedImages, failedImages };
}
