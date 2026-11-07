ALTER TABLE "groups" ADD COLUMN "trip_start" date;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "trip_end" date;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "time_zone" text DEFAULT 'Europe/Zurich' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "priced_rate" numeric(20, 10);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "priced_rate_currency" char(3);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "priced_source" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "priced_rate" numeric(20, 10);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "priced_rate_currency" char(3);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "priced_source" text;--> statement-breakpoint
UPDATE "expenses" AS t SET
  "priced_rate" = r."rate",
  "priced_rate_currency" = r."currency",
  "priced_source" = r."source"
FROM (
  SELECT x."id", x."currency", COALESCE(d."rate", m."rate") AS "rate",
    CASE WHEN d."rate" IS NOT NULL THEN 'day_override' ELSE 'market' END AS "source"
  FROM (
    SELECT "id", "group_id", "spent_on" AS "on", COALESCE("billed_currency", "currency") AS "currency"
    FROM "expenses"
    WHERE "currency" <> 'SGD'
      AND "billed_currency" IS DISTINCT FROM 'SGD'
      AND NOT ("rate" IS NOT NULL AND "rate_currency" = COALESCE("billed_currency", "currency"))
  ) x
  LEFT JOIN "daily_rates" d ON d."group_id" = x."group_id" AND d."rate_date" = x."on" AND d."base" = x."currency" AND d."quote" = 'SGD'
  LEFT JOIN "fx_rates" m ON m."rate_date" = x."on" AND m."base" = x."currency" AND m."quote" = 'SGD'
) r
WHERE t."id" = r."id" AND r."rate" IS NOT NULL;--> statement-breakpoint
UPDATE "settlements" AS t SET
  "priced_rate" = r."rate",
  "priced_rate_currency" = r."currency",
  "priced_source" = r."source"
FROM (
  SELECT x."id", x."currency", COALESCE(d."rate", m."rate") AS "rate",
    CASE WHEN d."rate" IS NOT NULL THEN 'day_override' ELSE 'market' END AS "source"
  FROM (
    SELECT "id", "group_id", "settled_on" AS "on", COALESCE("billed_currency", "currency") AS "currency"
    FROM "settlements"
    WHERE "currency" <> 'SGD'
      AND "billed_currency" IS DISTINCT FROM 'SGD'
      AND NOT ("rate" IS NOT NULL AND "rate_currency" = COALESCE("billed_currency", "currency"))
  ) x
  LEFT JOIN "daily_rates" d ON d."group_id" = x."group_id" AND d."rate_date" = x."on" AND d."base" = x."currency" AND d."quote" = 'SGD'
  LEFT JOIN "fx_rates" m ON m."rate_date" = x."on" AND m."base" = x."currency" AND m."quote" = 'SGD'
) r
WHERE t."id" = r."id" AND r."rate" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_trip_range_check" CHECK ("groups"."trip_start" IS NULL OR "groups"."trip_end" IS NULL OR "groups"."trip_end" >= "groups"."trip_start");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_priced_rate_check" CHECK (("expenses"."priced_rate" IS NULL AND "expenses"."priced_rate_currency" IS NULL AND "expenses"."priced_source" IS NULL)
        OR ("expenses"."priced_rate" IS NOT NULL AND "expenses"."priced_rate" > 0 AND "expenses"."priced_rate_currency" IS NOT NULL AND "expenses"."priced_rate_currency" ~ '^[A-Z]{3}$' AND "expenses"."priced_source" IN ('day_override', 'market')));--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_priced_rate_check" CHECK (("settlements"."priced_rate" IS NULL AND "settlements"."priced_rate_currency" IS NULL AND "settlements"."priced_source" IS NULL)
        OR ("settlements"."priced_rate" IS NOT NULL AND "settlements"."priced_rate" > 0 AND "settlements"."priced_rate_currency" IS NOT NULL AND "settlements"."priced_rate_currency" ~ '^[A-Z]{3}$' AND "settlements"."priced_source" IN ('day_override', 'market')));