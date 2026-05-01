-- DropTable (just deployed, only contains test data — safe to drop)
DROP TABLE IF EXISTS "pulse_hourly";

-- CreateTable
CREATE TABLE "pulse_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'XX',
    "region" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "pulse_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pulse_events_at_idx" ON "pulse_events"("at");

-- CreateIndex
CREATE INDEX "pulse_events_event_at_idx" ON "pulse_events"("event", "at");
