-- Simplify analytics: drop attribution/technical/conversion-flag columns from sessions,
-- drop meta from analytics_events, add occurredAt (client-supplied UTC timestamp),
-- replace indexes accordingly.

-- DropIndex
DROP INDEX IF EXISTS "sessions_userId_idx";
DROP INDEX IF EXISTS "sessions_companyId_idx";
DROP INDEX IF EXISTS "sessions_lastSeenAt_idx";

-- AlterTable: sessions — drop unused columns
ALTER TABLE "sessions"
  DROP COLUMN IF EXISTS "country",
  DROP COLUMN IF EXISTS "city",
  DROP COLUMN IF EXISTS "landingPage",
  DROP COLUMN IF EXISTS "gclid",
  DROP COLUMN IF EXISTS "keyword",
  DROP COLUMN IF EXISTS "browser",
  DROP COLUMN IF EXISTS "device",
  DROP COLUMN IF EXISTS "isBot",
  DROP COLUMN IF EXISTS "wasRegistered",
  DROP COLUMN IF EXISTS "namedRestaurant",
  DROP COLUMN IF EXISTS "selectedType",
  DROP COLUMN IF EXISTS "modifiedMenu",
  DROP COLUMN IF EXISTS "modifiedContacts",
  DROP COLUMN IF EXISTS "modifiedDesign",
  DROP COLUMN IF EXISTS "reached50Views",
  DROP COLUMN IF EXISTS "paidSubscription",
  DROP COLUMN IF EXISTS "conversionSent",
  DROP COLUMN IF EXISTS "conversionViewsSent",
  DROP COLUMN IF EXISTS "conversionSubscriptionSent",
  DROP COLUMN IF EXISTS "updatedAt";

-- Backfill lastSeenAt for legacy rows where it was nullable
UPDATE "sessions" SET "lastSeenAt" = "createdAt" WHERE "lastSeenAt" IS NULL;

-- Make lastSeenAt NOT NULL with default now()
ALTER TABLE "sessions"
  ALTER COLUMN "lastSeenAt" SET NOT NULL,
  ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "sessions_userId_createdAt_idx" ON "sessions"("userId", "createdAt");
CREATE INDEX "sessions_companyId_createdAt_idx" ON "sessions"("companyId", "createdAt");

-- DropIndex
DROP INDEX IF EXISTS "analytics_events_event_createdAt_idx";
DROP INDEX IF EXISTS "analytics_events_sessionId_idx";
DROP INDEX IF EXISTS "analytics_events_sessionId_createdAt_idx";
DROP INDEX IF EXISTS "analytics_events_createdAt_idx";

-- AlterTable: analytics_events — drop meta, add occurredAt
ALTER TABLE "analytics_events" DROP COLUMN IF EXISTS "meta";
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);

-- Backfill occurredAt from createdAt for legacy rows
UPDATE "analytics_events" SET "occurredAt" = "createdAt" WHERE "occurredAt" IS NULL;

-- Make occurredAt NOT NULL
ALTER TABLE "analytics_events" ALTER COLUMN "occurredAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "analytics_events_sessionId_occurredAt_idx" ON "analytics_events"("sessionId", "occurredAt");
CREATE INDEX "analytics_events_event_occurredAt_idx" ON "analytics_events"("event", "occurredAt");
