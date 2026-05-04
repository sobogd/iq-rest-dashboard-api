-- New unified analytics table. Anonymous by default; companyId / gclid set
-- server-side from auth cookie / SSR.
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'XX',
    "region" TEXT NOT NULL DEFAULT '',
    "device" TEXT,
    "platform" TEXT,
    "gclid" TEXT,
    "companyId" TEXT,
    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_events_at_idx" ON "usage_events"("at");
CREATE INDEX "usage_events_event_at_idx" ON "usage_events"("event", "at");
CREATE INDEX "usage_events_companyId_at_idx" ON "usage_events"("companyId", "at");
CREATE INDEX "usage_events_gclid_idx" ON "usage_events"("gclid");
