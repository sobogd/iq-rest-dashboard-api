-- CreateTable
CREATE TABLE "pulse_hourly" (
    "hour" TIMESTAMP(3) NOT NULL,
    "event" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'XX',
    "region" TEXT NOT NULL DEFAULT '',
    "hits" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pulse_hourly_pkey" PRIMARY KEY ("hour","event","country","region")
);

-- CreateIndex
CREATE INDEX "pulse_hourly_event_hour_idx" ON "pulse_hourly"("event", "hour");

-- CreateIndex
CREATE INDEX "pulse_hourly_hour_idx" ON "pulse_hourly"("hour");
