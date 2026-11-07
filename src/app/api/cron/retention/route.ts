import { handleRetentionRequest } from "@/server/import/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron issues a GET with the secret; POST lets the job be run by hand.
export const GET = handleRetentionRequest;
export const POST = handleRetentionRequest;
