-- Coarse classification of the inbound Referer header at landing time.
-- Stored as a short string ("google_search", "bing", "yandex", "social",
-- "internal", "other", …). Null when no referrer was present (direct
-- navigation, app-launched, etc.). The raw Referer URL is never persisted.
ALTER TABLE "usage_events" ADD COLUMN "referrer_source" TEXT;
CREATE INDEX "usage_events_referrer_source_at_idx" ON "usage_events" ("referrer_source", "at");
