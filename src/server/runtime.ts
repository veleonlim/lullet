import { connection } from "next/server";
import { getDatabase } from "@/db/client";
import { getSession } from "@/lib/auth/session";
import { FrankfurterClient, type FxRateClient } from "@/lib/fx";
import { createLedgerStore, type LedgerStore } from "./ledger";

const globalForFx = globalThis as unknown as { __lulletFx?: FxRateClient };

function fxClient(): FxRateClient {
  globalForFx.__lulletFx ??= new FrankfurterClient();
  return globalForFx.__lulletFx;
}

/**
 * The ledger for whoever is asking, or null when nobody is signed in. Every page and
 * server action gets its data only through this: the caller comes from `getSession`
 * and the store scopes every query to that session's group.
 */
export async function openStore(): Promise<LedgerStore | null> {
  // Ledger pages depend on who is asking and on live data: never prerender them.
  await connection();
  const session = await getSession();
  if (!session) return null;
  return createLedgerStore({ db: getDatabase().db, session, fx: fxClient() });
}
