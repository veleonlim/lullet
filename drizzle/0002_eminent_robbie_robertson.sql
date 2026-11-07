ALTER TABLE "expenses" DROP CONSTRAINT "expenses_rate_check";--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT "settlements_rate_check";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "rate_currency" char(3);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "rate_currency" char(3);--> statement-breakpoint
UPDATE "expenses" SET "rate_currency" = COALESCE("billed_currency", "currency") WHERE "rate" IS NOT NULL;--> statement-breakpoint
UPDATE "settlements" SET "rate_currency" = COALESCE("billed_currency", "currency") WHERE "rate" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_rate_check" CHECK (("expenses"."rate" IS NULL AND "expenses"."rate_currency" IS NULL)
        OR ("expenses"."rate" IS NOT NULL AND "expenses"."rate" > 0 AND "expenses"."rate_currency" IS NOT NULL AND "expenses"."rate_currency" ~ '^[A-Z]{3}$'));--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_rate_check" CHECK (("settlements"."rate" IS NULL AND "settlements"."rate_currency" IS NULL)
        OR ("settlements"."rate" IS NOT NULL AND "settlements"."rate" > 0 AND "settlements"."rate_currency" IS NOT NULL AND "settlements"."rate_currency" ~ '^[A-Z]{3}$'));