CREATE TABLE "member_aliases" (
	"group_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_aliases_group_id_alias_pk" PRIMARY KEY("group_id","alias"),
	CONSTRAINT "member_aliases_alias_check" CHECK ("member_aliases"."alias" = lower(btrim("member_aliases"."alias")) AND char_length("member_aliases"."alias") BETWEEN 2 AND 30)
);
--> statement-breakpoint
CREATE TABLE "telegram_drafts" (
	"import_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"view" text DEFAULT 'summary' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_drafts_message_key" UNIQUE("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_aliases" ADD CONSTRAINT "member_aliases_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_aliases" ADD CONSTRAINT "member_aliases_membership_fk" FOREIGN KEY ("group_id","user_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_drafts" ADD CONSTRAINT "telegram_drafts_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_updates_received_idx" ON "telegram_updates" USING btree ("received_at");