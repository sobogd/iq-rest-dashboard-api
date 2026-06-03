-- Manual admin attribution of a session to a restaurant (highest precedence,
-- never touched by the stitching pass).
ALTER TABLE "usage_events" ADD COLUMN "manualRestaurantId" TEXT;
CREATE INDEX "usage_events_manualRestaurantId_idx" ON "usage_events"("manualRestaurantId");
