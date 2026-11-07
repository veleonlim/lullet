import { defineConfig } from "drizzle-kit";

// Migrations should use a direct (non-pooled) connection when one is available (Neon).
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
});
