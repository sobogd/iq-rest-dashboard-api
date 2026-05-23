-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN "is_facebook_ads" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "usage_events_is_facebook_ads_at_idx" ON "usage_events"("is_facebook_ads", "at");
