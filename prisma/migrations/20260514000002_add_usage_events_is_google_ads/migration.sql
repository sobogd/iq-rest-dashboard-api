-- Flag visits that originated from a Google Ads click. The middleware path
-- detects this from the URL (gclid/gbraid/wbraid param) at landing time and
-- sets a client-side localStorage marker; subsequent JS-fired events from the
-- same browser send the flag so they're not misclassified as organic search
-- (the visit's referrer is still google.com after the Ads redirect).
ALTER TABLE "usage_events" ADD COLUMN "is_google_ads" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "usage_events_is_google_ads_at_idx" ON "usage_events" ("is_google_ads", "at");
