/**
 * Runs once when a server instance starts. In production it checks the settings and refuses to
 * start with a message naming every missing or malformed variable (never their values), so a
 * forgotten secret shows up in the host's logs at once instead of as a mystery error later.
 * Not run while building, in development, or in the end to end suite (LULLET_SKIP_ENV_CHECK).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.LULLET_SKIP_ENV_CHECK) return;
  const { assertProductionEnv } = await import("@/lib/config/env");
  assertProductionEnv(process.env);
}
