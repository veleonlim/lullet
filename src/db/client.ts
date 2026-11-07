import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * One connection setup for every environment. node-postgres speaks plain TCP, so
 * the same code runs against Docker Postgres locally and in CI and against Neon's
 * pooled endpoint in production (PgBouncer in transaction mode: no session state,
 * no named prepared statements, both of which this code avoids). It uses no host
 * specific API, so moving to an always-on host changes only the deployment.
 */

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
}

export interface ConnectionOptions {
  readonly connectionString: string;
  /** Upper bound on connections held by this process. Keep it at 1 or 2 on serverless hosts. */
  readonly max?: number;
}

export function createDatabase(options: ConnectionOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    // Do not keep the process (a test run, a script) alive for idle sockets.
    allowExitOnIdle: true,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client can be dropped by the server or the pooler; that must not crash the process.
  pool.on("error", (error) => {
    console.error("Unexpected error on an idle database connection", error);
  });
  return { db: drizzle({ client: pool, schema, casing: "snake_case" }), pool };
}

const globalForDb = globalThis as unknown as { __lulletDb?: DatabaseHandle };

/** The process wide handle, created on first use from DATABASE_URL (kept across dev reloads). */
export function getDatabase(): DatabaseHandle {
  if (!globalForDb.__lulletDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env (see the README).");
    }
    const max = Number(process.env.DATABASE_POOL_MAX ?? "5");
    globalForDb.__lulletDb = createDatabase({
      connectionString,
      max: Number.isInteger(max) && max > 0 ? max : 5,
    });
  }
  return globalForDb.__lulletDb;
}
