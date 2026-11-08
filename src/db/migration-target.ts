/**
 * Safety checks for the deliberate production migration step (`pnpm db:migrate:prod`). Migrations
 * go through Neon's direct (unpooled) address: the pooler runs in transaction mode, which does not
 * suit schema changes, and a migration must be a conscious step, never a side effect of a cold start.
 */

function parse(connectionString: string): URL {
  try {
    return new URL(connectionString);
  } catch {
    throw new Error("The database connection string is not a valid address.");
  }
}

/** Where a connection string points, safe to print: host, port and database, never the password. */
export function describeDatabaseTarget(connectionString: string): string {
  const url = parse(connectionString);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return `${url.hostname}${url.port ? `:${url.port}` : ""}/${name}`;
}

/** True for a Neon pooled host (the endpoint id ends in `-pooler`). */
export function isPooledUrl(connectionString: string): boolean {
  const url = parse(connectionString);
  return url.hostname.split(".")[0]?.endsWith("-pooler") ?? false;
}

/** Throws unless the address is a direct one; the message says what to copy instead. */
export function assertDirectUrl(connectionString: string | undefined): string {
  if (!connectionString?.trim()) {
    throw new Error(
      "DATABASE_URL_UNPOOLED is not set. Copy Neon's connection string with the pooler switched OFF (see docs/LAUNCH.md).",
    );
  }
  if (isPooledUrl(connectionString)) {
    throw new Error(
      "DATABASE_URL_UNPOOLED points at Neon's pooler (the host contains -pooler). Use the direct connection string, with the pooler switched OFF.",
    );
  }
  return connectionString;
}
