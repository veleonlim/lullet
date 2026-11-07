CREATE TYPE "public"."expense_category" AS ENUM('food', 'transport', 'stay', 'sightseeing', 'shopping', 'other');--> statement-breakpoint
CREATE TYPE "public"."split_method" AS ENUM('equal', 'exact', 'percent', 'shares');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('telegram', 'web');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('draft', 'confirmed', 'cancelled', 'expired', 'undone');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"group_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"day" date,
	"amount_minor" bigint NOT NULL,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_group_day_key" UNIQUE NULLS NOT DISTINCT("group_id","day"),
	CONSTRAINT "budgets_amount_check" CHECK ("budgets"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "daily_rates" (
	"group_id" uuid NOT NULL,
	"rate_date" date NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) DEFAULT 'SGD' NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_rates_group_id_rate_date_base_quote_pk" PRIMARY KEY("group_id","rate_date","base","quote"),
	CONSTRAINT "daily_rates_pair_check" CHECK ("daily_rates"."base" ~ '^[A-Z]{3}$' AND "daily_rates"."quote" ~ '^[A-Z]{3}$' AND "daily_rates"."base" <> "daily_rates"."quote"),
	CONSTRAINT "daily_rates_rate_check" CHECK ("daily_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"rate_date" date NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"source_date" date NOT NULL,
	"provider" text DEFAULT 'frankfurter' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_date_base_quote_pk" PRIMARY KEY("rate_date","base","quote"),
	CONSTRAINT "fx_rates_pair_check" CHECK ("fx_rates"."base" ~ '^[A-Z]{3}$' AND "fx_rates"."quote" ~ '^[A-Z]{3}$' AND "fx_rates"."base" <> "fx_rates"."quote"),
	CONSTRAINT "fx_rates_rate_check" CHECK ("fx_rates"."rate" > 0),
	CONSTRAINT "fx_rates_source_date_check" CHECK ("fx_rates"."source_date" <= "fx_rates"."rate_date")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_group_user_key" UNIQUE("group_id","user_id"),
	CONSTRAINT "memberships_group_position_key" UNIQUE("group_id","position"),
	CONSTRAINT "memberships_position_check" CHECK ("memberships"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"private_chat_id" bigint,
	"username" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "telegram_links_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "telegram_links_ids_check" CHECK ("telegram_links"."telegram_user_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"merchant" text,
	"amount_text" text,
	"amount_minor" bigint,
	"currency" char(3),
	"billed_amount_text" text,
	"billed_amount_minor" bigint,
	"billed_currency" char(3),
	"spent_on" date,
	"category" "expense_category",
	"category_confidence" smallint,
	"included" boolean DEFAULT true NOT NULL,
	"issues" text[] DEFAULT '{}'::text[] NOT NULL,
	"draft_split" jsonb,
	CONSTRAINT "import_rows_import_position_key" UNIQUE("import_id","position"),
	CONSTRAINT "import_rows_amount_check" CHECK ("import_rows"."amount_minor" IS NULL OR "import_rows"."amount_minor" > 0),
	CONSTRAINT "import_rows_currency_check" CHECK ("import_rows"."currency" IS NULL OR "import_rows"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "import_rows_billed_check" CHECK (("import_rows"."billed_amount_minor" IS NULL OR "import_rows"."billed_amount_minor" > 0)
        AND ("import_rows"."billed_currency" IS NULL OR "import_rows"."billed_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "import_rows_confidence_check" CHECK ("import_rows"."category_confidence" IS NULL OR "import_rows"."category_confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"status" "import_status" DEFAULT 'draft' NOT NULL,
	"image_sha256" char(64) NOT NULL,
	"storage_key" text,
	"image_deleted_at" timestamp with time zone,
	"caption" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	CONSTRAINT "imports_sha256_check" CHECK ("imports"."image_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "imports_confirmed_check" CHECK ("imports"."status" NOT IN ('confirmed', 'undone') OR "imports"."confirmed_at" IS NOT NULL),
	CONSTRAINT "imports_undone_check" CHECK (("imports"."status" = 'undone') = ("imports"."undone_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "expense_payers" (
	"expense_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "expense_payers_expense_id_user_id_pk" PRIMARY KEY("expense_id","user_id"),
	CONSTRAINT "expense_payers_amount_check" CHECK ("expense_payers"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_shares" (
	"expense_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"weight" integer,
	CONSTRAINT "expense_shares_expense_id_user_id_pk" PRIMARY KEY("expense_id","user_id"),
	CONSTRAINT "expense_shares_amount_check" CHECK ("expense_shares"."amount_minor" >= 0),
	CONSTRAINT "expense_shares_weight_check" CHECK ("expense_shares"."weight" IS NULL OR "expense_shares"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"import_id" uuid,
	"import_row_id" uuid,
	"description" text NOT NULL,
	"category" "expense_category" DEFAULT 'other' NOT NULL,
	"spent_on" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"billed_amount_minor" bigint,
	"billed_currency" char(3),
	"rate" numeric(20, 10),
	"split_method" "split_method" DEFAULT 'equal' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "expenses_import_row_id_unique" UNIQUE("import_row_id"),
	CONSTRAINT "expenses_id_group_key" UNIQUE("id","group_id"),
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount_minor" > 0),
	CONSTRAINT "expenses_currency_check" CHECK ("expenses"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expenses_billed_check" CHECK (("expenses"."billed_amount_minor" IS NULL AND "expenses"."billed_currency" IS NULL)
        OR ("expenses"."billed_amount_minor" IS NOT NULL AND "expenses"."billed_amount_minor" > 0 AND "expenses"."billed_currency" IS NOT NULL AND "expenses"."billed_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "expenses_rate_check" CHECK ("expenses"."rate" IS NULL OR "expenses"."rate" > 0),
	CONSTRAINT "expenses_soft_delete_check" CHECK (("expenses"."deleted_at" IS NULL) = ("expenses"."deleted_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"billed_amount_minor" bigint,
	"billed_currency" char(3),
	"rate" numeric(20, 10),
	"settled_on" date NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "settlements_parties_check" CHECK ("settlements"."from_user_id" <> "settlements"."to_user_id"),
	CONSTRAINT "settlements_amount_check" CHECK ("settlements"."amount_minor" > 0),
	CONSTRAINT "settlements_currency_check" CHECK ("settlements"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "settlements_billed_check" CHECK (("settlements"."billed_amount_minor" IS NULL AND "settlements"."billed_currency" IS NULL)
        OR ("settlements"."billed_amount_minor" IS NOT NULL AND "settlements"."billed_amount_minor" > 0 AND "settlements"."billed_currency" IS NOT NULL AND "settlements"."billed_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "settlements_rate_check" CHECK ("settlements"."rate" IS NULL OR "settlements"."rate" > 0),
	CONSTRAINT "settlements_soft_delete_check" CHECK (("settlements"."deleted_at" IS NULL) = ("settlements"."deleted_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rates" ADD CONSTRAINT "daily_rates_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rates" ADD CONSTRAINT "daily_rates_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_uploader_membership_fk" FOREIGN KEY ("group_id","uploader_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_expense_fk" FOREIGN KEY ("expense_id","group_id") REFERENCES "public"."expenses"("id","group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_membership_fk" FOREIGN KEY ("group_id","user_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_fk" FOREIGN KEY ("expense_id","group_id") REFERENCES "public"."expenses"("id","group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_membership_fk" FOREIGN KEY ("group_id","user_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_import_row_id_import_rows_id_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_membership_fk" FOREIGN KEY ("group_id","from_user_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_membership_fk" FOREIGN KEY ("group_id","to_user_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_group_created_idx" ON "audit_log" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imports_group_image_active_key" ON "imports" USING btree ("group_id","image_sha256") WHERE "imports"."status" IN ('draft', 'confirmed');--> statement-breakpoint
CREATE INDEX "imports_group_created_idx" ON "imports" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "expenses_group_spent_on_idx" ON "expenses" USING btree ("group_id","spent_on") WHERE "expenses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "settlements_group_settled_on_idx" ON "settlements" USING btree ("group_id","settled_on") WHERE "settlements"."deleted_at" IS NULL;