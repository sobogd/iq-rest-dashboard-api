-- Drop the legacy analytics tables. Their content was migrated into
-- usage_events by scripts/migrate-to-usage-events.sql.
DROP TABLE IF EXISTS "analytics_events";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "pulse_events";
