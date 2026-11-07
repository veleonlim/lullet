import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getDatabase } from "@/db/client";
import { dailyUploadLimit } from "@/lib/import/policy";
import { getSession } from "@/lib/auth/session";
import { fxClient } from "@/server/runtime";
import { getExtractor } from "./extract";
import type { ImportDeps } from "./service";
import { getStorage } from "./storage";
import { createImportStore, type ImportStore } from "./store";

/**
 * The import pipeline for whoever is asking, or null when nobody is signed in. Route handlers
 * answer null with a 401 (a redirect to the sign-in page would be the wrong reply to an API call).
 */
export async function openImportDeps(): Promise<ImportDeps | null> {
  const session = await getSession();
  if (!session) return null;
  const store = createImportStore({ db: getDatabase().db, session, fx: fxClient() });
  return {
    store,
    storage: getStorage(),
    extractor: getExtractor(),
    dailyLimit: dailyUploadLimit(process.env.IMPORT_DAILY_LIMIT),
    groupId: session.groupId,
  };
}

/** For pages: the import store for whoever is asking; anyone without a session goes to the sign-in page. */
export async function openImportStore(): Promise<ImportStore> {
  await connection();
  const session = await getSession();
  if (!session) redirect("/signin");
  return createImportStore({ db: getDatabase().db, session, fx: fxClient() });
}
