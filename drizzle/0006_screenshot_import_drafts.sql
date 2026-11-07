ALTER TABLE "import_rows" ADD COLUMN "date_text" text;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "field_states" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "duplicate_of" jsonb;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "media_type" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "rereads" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "screen_total_text" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "screen_total_minor" bigint;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "screen_total_currency" char(3);--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "notes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_draft_expiry_check" CHECK ("imports"."status" <> 'draft' OR "imports"."expires_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_rereads_check" CHECK ("imports"."rereads" >= 0);--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_screen_total_check" CHECK (("imports"."screen_total_minor" IS NULL OR "imports"."screen_total_minor" > 0)
        AND ("imports"."screen_total_currency" IS NULL OR "imports"."screen_total_currency" ~ '^[A-Z]{3}$'));