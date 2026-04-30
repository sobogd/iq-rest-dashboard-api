-- Drop Session.lastSeenAt — write amplification on hot row, replaced by MAX(events.occurredAt) when needed.
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "lastSeenAt";
