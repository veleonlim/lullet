import { getDatabase, type Database } from "@/db/client";
import { getSessionSecret } from "./config";

/** Everything the database-backed auth functions need, each defaulting to the process wide value. */
export interface AuthDeps {
  readonly db?: Database;
  readonly secret?: string;
  readonly now?: Date;
}

export interface ResolvedDeps {
  readonly db: Database;
  readonly secret: string;
  readonly now: Date;
}

export function resolveDeps(deps: AuthDeps = {}): ResolvedDeps {
  return {
    db: deps.db ?? getDatabase().db,
    secret: deps.secret ?? getSessionSecret(),
    now: deps.now ?? new Date(),
  };
}

export const addSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);
