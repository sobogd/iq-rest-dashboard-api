-- Identity stitched from device-fingerprint islands (anonymous pre-login
-- activity attributed to the user/restaurant that later logged in).
ALTER TABLE "usage_events" ADD COLUMN "stitchedUserId" TEXT;
ALTER TABLE "usage_events" ADD COLUMN "stitchedRestaurantId" TEXT;
CREATE INDEX "usage_events_stitchedRestaurantId_idx" ON "usage_events"("stitchedRestaurantId");
