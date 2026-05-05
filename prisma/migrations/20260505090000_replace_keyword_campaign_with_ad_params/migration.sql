ALTER TABLE "usage_events" DROP COLUMN IF EXISTS "keyword";
ALTER TABLE "usage_events" DROP COLUMN IF EXISTS "campaign";
ALTER TABLE "usage_events" ADD COLUMN "ad_params" TEXT;
