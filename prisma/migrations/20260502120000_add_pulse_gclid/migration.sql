-- AlterTable
ALTER TABLE "pulse_events" ADD COLUMN "gclid" TEXT;

-- CreateIndex
CREATE INDEX "pulse_events_gclid_idx" ON "pulse_events"("gclid");
