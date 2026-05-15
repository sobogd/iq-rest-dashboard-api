-- Drop the is_bot column from usage_events. Bot arrivals are now filtered at
-- write time in UsageController.track() and never reach the table, so the flag
-- has no readers left. Also remove the supporting index. Existing bot rows
-- are deleted in the same migration so historical aggregates don't carry the
-- noise either.

DELETE FROM "usage_events" WHERE "is_bot" = true;

DROP INDEX IF EXISTS "usage_events_is_bot_at_idx";

ALTER TABLE "usage_events" DROP COLUMN IF EXISTS "is_bot";
