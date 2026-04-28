-- Pre-merge: for each userId with multiple sessionIds,
-- keep the oldest sessionId and move all events to it.
-- This runs BEFORE the Session table migration.

DO $$
DECLARE
    rec RECORD;
    canonical_sid TEXT;
BEGIN
    FOR rec IN
        SELECT "userId", COUNT(DISTINCT "sessionId") as cnt
        FROM analytics_events
        WHERE "userId" IS NOT NULL
        GROUP BY "userId"
        HAVING COUNT(DISTINCT "sessionId") > 1
    LOOP
        -- Pick the oldest sessionId for this user
        SELECT "sessionId" INTO canonical_sid
        FROM analytics_events
        WHERE "userId" = rec."userId"
        ORDER BY "createdAt" ASC
        LIMIT 1;

        -- Move all events for this user to the canonical sessionId
        UPDATE analytics_events
        SET "sessionId" = canonical_sid
        WHERE "userId" = rec."userId"
          AND "sessionId" != canonical_sid;
    END LOOP;
END $$;
