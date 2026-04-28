-- Step 1: Create sessions table
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "country" TEXT,
    "gclid" TEXT,
    "keyword" TEXT,
    "userAgent" TEXT,
    "browser" TEXT,
    "device" TEXT,
    "ip" TEXT,
    "userId" TEXT,
    "companyId" TEXT,
    "wasRegistered" BOOLEAN NOT NULL DEFAULT false,
    "namedRestaurant" BOOLEAN NOT NULL DEFAULT false,
    "selectedType" BOOLEAN NOT NULL DEFAULT false,
    "modifiedMenu" BOOLEAN NOT NULL DEFAULT false,
    "modifiedContacts" BOOLEAN NOT NULL DEFAULT false,
    "modifiedDesign" BOOLEAN NOT NULL DEFAULT false,
    "reached50Views" BOOLEAN NOT NULL DEFAULT false,
    "paidSubscription" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- Step 2: Populate sessions from existing analytics_events
-- For each distinct sessionId, create a Session record.
-- Pre-merge already unified sessionIds per userId, so no duplicates expected.
-- First-touch fields (country, gclid, keyword) from the earliest event.
-- Last-touch fields (userAgent, ip) from the latest event.
-- userId from any event that has it.

INSERT INTO "sessions" ("id", "country", "gclid", "keyword", "userAgent", "ip", "userId", "createdAt", "updatedAt")
SELECT
    ae."sessionId",
    -- first-touch: country from earliest event with geo
    (SELECT (e2.meta->'geo'->>'country')
     FROM analytics_events e2
     WHERE e2."sessionId" = ae."sessionId"
       AND e2.meta->'geo'->>'country' IS NOT NULL
     ORDER BY e2."createdAt" ASC
     LIMIT 1),
    -- first-touch: gclid from earliest event with gclid
    (SELECT (e2.meta->'params'->>'gclid')
     FROM analytics_events e2
     WHERE e2."sessionId" = ae."sessionId"
       AND e2.meta->'params'->>'gclid' IS NOT NULL
     ORDER BY e2."createdAt" ASC
     LIMIT 1),
    -- first-touch: keyword from earliest event with kw
    (SELECT (e2.meta->'params'->>'kw')
     FROM analytics_events e2
     WHERE e2."sessionId" = ae."sessionId"
       AND e2.meta->'params'->>'kw' IS NOT NULL
     ORDER BY e2."createdAt" ASC
     LIMIT 1),
    -- last-touch: userAgent from latest event
    (SELECT (e2.meta->>'userAgent')
     FROM analytics_events e2
     WHERE e2."sessionId" = ae."sessionId"
       AND e2.meta->>'userAgent' IS NOT NULL
     ORDER BY e2."createdAt" DESC
     LIMIT 1),
    -- last-touch: ip from latest event
    (SELECT (e2.meta->>'ip')
     FROM analytics_events e2
     WHERE e2."sessionId" = ae."sessionId"
       AND e2.meta->>'ip' IS NOT NULL
     ORDER BY e2."createdAt" DESC
     LIMIT 1),
    -- userId from any event
    (SELECT e2."userId"
     FROM analytics_events e2
     WHERE e2."sessionId" = ae."sessionId"
       AND e2."userId" IS NOT NULL
     LIMIT 1),
    -- createdAt = earliest event time
    MIN(ae."createdAt"),
    -- updatedAt = latest event time
    MAX(ae."createdAt")
FROM analytics_events ae
GROUP BY ae."sessionId";

-- Step 2b: Set browser and device by parsing userAgent (basic classification)
UPDATE "sessions"
SET "browser" = CASE
    WHEN "userAgent" LIKE '%Edg/%' THEN 'Edge'
    WHEN "userAgent" LIKE '%OPR/%' OR "userAgent" LIKE '%Opera%' THEN 'Opera'
    WHEN "userAgent" LIKE '%Chrome/%' AND "userAgent" NOT LIKE '%Edg/%' AND "userAgent" NOT LIKE '%OPR/%' THEN 'Chrome'
    WHEN "userAgent" LIKE '%Safari/%' AND "userAgent" NOT LIKE '%Chrome/%' THEN 'Safari'
    WHEN "userAgent" LIKE '%Firefox/%' THEN 'Firefox'
    ELSE NULL
END
WHERE "userAgent" IS NOT NULL;

UPDATE "sessions"
SET "device" = CASE
    WHEN "userAgent" LIKE '%Mobile%' OR "userAgent" LIKE '%Android%' THEN 'mobile'
    WHEN "userAgent" LIKE '%iPad%' OR "userAgent" LIKE '%Tablet%' THEN 'tablet'
    ELSE 'desktop'
END
WHERE "userAgent" IS NOT NULL;

-- Step 3: Set companyId from userId
UPDATE "sessions" s
SET "companyId" = uc."companyId"
FROM users_companies uc
WHERE s."userId" = uc."userId"
  AND s."companyId" IS NULL;

-- Step 4: Set conversion flags
-- wasRegistered: true if userId is not null
UPDATE "sessions"
SET "wasRegistered" = true
WHERE "userId" IS NOT NULL;

-- namedRestaurant: true if there is a clicked_onboarding_continue event
UPDATE "sessions" s
SET "namedRestaurant" = true
WHERE EXISTS (
    SELECT 1 FROM analytics_events ae
    WHERE ae."sessionId" = s."id" AND ae.event = 'clicked_onboarding_continue'
);

-- selectedType: true if there is a clicked_onboarding_type event
UPDATE "sessions" s
SET "selectedType" = true
WHERE EXISTS (
    SELECT 1 FROM analytics_events ae
    WHERE ae."sessionId" = s."id" AND ae.event = 'clicked_onboarding_type'
);

-- modifiedMenu: from Restaurant.checklistMenuEdited
UPDATE "sessions" s
SET "modifiedMenu" = true
WHERE s."companyId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM restaurants r
    WHERE r."companyId" = s."companyId" AND r."checklistMenuEdited" = true
);

-- modifiedContacts: from Restaurant.checklistContactsSaved
UPDATE "sessions" s
SET "modifiedContacts" = true
WHERE s."companyId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM restaurants r
    WHERE r."companyId" = s."companyId" AND r."checklistContactsSaved" = true
);

-- modifiedDesign: from Restaurant.checklistBrandCustomized
UPDATE "sessions" s
SET "modifiedDesign" = true
WHERE s."companyId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM restaurants r
    WHERE r."companyId" = s."companyId" AND r."checklistBrandCustomized" = true
);

-- reached50Views: true if page_views count for companyId >= 50
UPDATE "sessions" s
SET "reached50Views" = true
WHERE s."companyId" IS NOT NULL
  AND (
    SELECT COUNT(*) FROM page_views pv
    WHERE pv."companyId" = s."companyId"
) >= 50;

-- paidSubscription: true if company has active/past_due/canceled subscription
UPDATE "sessions" s
SET "paidSubscription" = true
WHERE s."companyId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM companies c
    WHERE c.id = s."companyId"
      AND c."subscriptionStatus" IN ('ACTIVE', 'PAST_DUE', 'CANCELED')
);

-- Step 5: Drop old columns from analytics_events
ALTER TABLE "analytics_events" DROP COLUMN IF EXISTS "userId";
ALTER TABLE "analytics_events" DROP COLUMN IF EXISTS "page";
ALTER TABLE "analytics_events" DROP COLUMN IF EXISTS "meta";

-- Drop the old userId index (no longer exists)
DROP INDEX IF EXISTS "analytics_events_userId_idx";

-- Step 6: Add FK constraint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 7: Create indexes on sessions
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");
CREATE INDEX "sessions_companyId_idx" ON "sessions"("companyId");
CREATE INDEX "sessions_createdAt_idx" ON "sessions"("createdAt");
