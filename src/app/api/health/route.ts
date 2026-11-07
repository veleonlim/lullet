export const dynamic = "force-dynamic";

/** Liveness probe for the container host. Deliberately independent of the database. */
export function GET() {
  return Response.json({ status: "ok" });
}
