-- Flag landing/page events from known bot User-Agents. The UA itself is never
-- persisted (GDPR); middleware reads it from the request header and writes
-- only this derived boolean. Default false keeps existing rows intact.
ALTER TABLE "usage_events" ADD COLUMN "is_bot" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "usage_events_is_bot_at_idx" ON "usage_events" ("is_bot", "at");
