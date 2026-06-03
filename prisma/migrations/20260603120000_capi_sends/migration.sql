-- Journal of manual Meta CAPI sends; replaces UsageEvent.fbSentEvents.
CREATE TABLE "capi_sends" (
  "id" TEXT NOT NULL,
  "fbclid" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capi_sends_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "capi_sends_fbclid_idx" ON "capi_sends"("fbclid");
CREATE INDEX "capi_sends_fbclid_eventName_status_idx" ON "capi_sends"("fbclid", "eventName", "status");

-- Backfill previously-sent conversions from usage_events.fbSentEvents so the
-- dedup history is preserved (recorded as successful, with no response body).
INSERT INTO "capi_sends" ("id", "fbclid", "eventName", "status", "response", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || ev_name),
       substring(ue."event" from '^l_fbclid_(.+)$'),
       ev_name,
       'success',
       NULL,
       ue."at"
FROM "usage_events" ue, unnest(ue."fbSentEvents") AS ev_name
WHERE ue."event" LIKE 'l_fbclid_%'
  AND substring(ue."event" from '^l_fbclid_(.+)$') IS NOT NULL;

-- Drop the legacy array column.
ALTER TABLE "usage_events" DROP COLUMN "fbSentEvents";
