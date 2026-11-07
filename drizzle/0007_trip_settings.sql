ALTER TABLE "groups" ADD COLUMN "trip_start" date;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "trip_end" date;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "time_zone" text DEFAULT 'Europe/Zurich' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_trip_range_check" CHECK ("groups"."trip_start" IS NULL OR "groups"."trip_end" IS NULL OR "groups"."trip_end" >= "groups"."trip_start");