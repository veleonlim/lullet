import type { Database } from "@/db/client";
import type { Extraction } from "@/lib/import/extraction";
import { rowToEdit, type DraftEdit, type DraftView } from "@/lib/import";
import { createImportStore, type ImportStore } from "@/server/import/store";
import type { ImportDeps } from "@/server/import/service";
import type {
  ExtractionOutcome,
  ExtractionRequest,
  ImageExtractor,
} from "@/server/import/extract/types";
import type { ImageStorage, StoredImage } from "@/server/import/storage/types";
import { wireframeExtraction } from "@/test-support/extraction";
import type { Seed } from "./helpers";
import { FakeFx, RATES } from "./ledger-support";

/** Screenshot storage in memory, with a switch to make deleting fail. */
export class MemoryStorage implements ImageStorage {
  readonly objects = new Map<string, StoredImage>();
  failDeletes = false;

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<StoredImage | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error("storage is down"));
    this.objects.delete(key);
    return Promise.resolve();
  }
}

/** A model stand-in that answers from a queue and counts every call. */
export class ScriptedExtractor implements ImageExtractor {
  readonly requests: ExtractionRequest[] = [];
  private readonly queue: ExtractionOutcome[] = [];

  constructor(private fallback: ExtractionOutcome = ok(wireframeExtraction())) {}

  enqueue(...outcomes: ExtractionOutcome[]): void {
    this.queue.push(...outcomes);
  }

  extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
    this.requests.push(request);
    return Promise.resolve(this.queue.shift() ?? this.fallback);
  }
}

export function ok(extraction: Extraction, model = "claude-haiku-5-5"): ExtractionOutcome {
  return { ok: true, model, extraction };
}

export interface World {
  readonly seed: Seed;
  readonly storage: MemoryStorage;
  readonly extractor: ScriptedExtractor;
  /** The pipeline for member `index` (0 is the first member), with a shared clock. */
  as(index: number): ImportDeps;
  store(index: number): ImportStore;
  clock: { now: Date };
}

export function buildWorld(
  db: Database,
  seed: Seed,
  start = new Date("2026-11-08T10:00:00Z"),
): World {
  const storage = new MemoryStorage();
  const extractor = new ScriptedExtractor();
  const clock = { now: start };
  const deps = (index: number): ImportDeps => {
    const userId = seed.userIds[index];
    if (userId === undefined) throw new Error("no such member");
    const store = createImportStore({
      db,
      session: { userId, groupId: seed.groupId },
      fx: new FakeFx(RATES),
      now: () => clock.now,
    });
    return {
      store,
      storage,
      extractor,
      dailyLimit: 5,
      groupId: seed.groupId,
      now: () => clock.now,
    };
  };
  return {
    seed,
    storage,
    extractor,
    as: deps,
    store: (index) => deps(index).store,
    clock,
  };
}

/** The edit that changes nothing: what the screen sends when the person only presses Add. */
export function unchanged(view: DraftView): DraftEdit {
  return { batch: view.batch, rows: view.rows.map(rowToEdit) };
}
