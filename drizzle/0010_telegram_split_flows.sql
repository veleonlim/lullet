CREATE TABLE "telegram_split_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint,
	"step" text NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_split_flows_member_key" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_split_flows" ADD CONSTRAINT "telegram_split_flows_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_split_flows" ADD CONSTRAINT "telegram_split_flows_membership_fk" FOREIGN KEY ("group_id","user_id") REFERENCES "public"."memberships"("group_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_split_flows_expires_idx" ON "telegram_split_flows" USING btree ("expires_at");