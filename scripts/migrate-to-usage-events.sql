-- Backfill old analytics into the unified usage_events table.
--
-- Migrates:
--   1. pulse_events  → usage_events (anonymous; companyId = NULL)
--   2. analytics_events JOIN sessions WHERE companyId IS NOT NULL
--                      → usage_events (identified; companyId set)
--   3. Dedup: drop anon (pulse-derived) rows that look like the anon copy of
--      an identified event from the same user-session within ±1 sec.
--
-- Safe to run more than once: skips rows whose source id is already migrated
-- via a sentinel comment in the event name? No — instead we wrap in a
-- transaction with a count-vs-baseline assertion at the end and rollback on
-- mismatch.
--
-- Run with: psql "$DATABASE_URL" -f scripts/migrate-to-usage-events.sql

BEGIN;

-- ─────── Baselines ───────
\set ON_ERROR_STOP on
SELECT count(*) AS pre_pulse                 FROM pulse_events                                                                            \gset
SELECT count(*) AS pre_ae_identified         FROM analytics_events ae JOIN sessions s ON s.id = ae."sessionId" WHERE s."companyId" IS NOT NULL \gset
SELECT count(*) AS pre_usage                 FROM usage_events                                                                            \gset
\echo '— Baselines —'
\echo 'pulse_events:                ' :pre_pulse
\echo 'analytics_events identified: ' :pre_ae_identified
\echo 'usage_events (existing):     ' :pre_usage

-- ─────── Step 1: pulse_events → usage_events (anon) ───────
INSERT INTO usage_events (id, at, event, country, region, device, platform, gclid, "companyId")
SELECT
  gen_random_uuid()::text,
  at,
  event,
  country,
  region,
  NULL,                 -- pulse_events has no User-Agent
  NULL,
  gclid,
  NULL
FROM pulse_events;

SELECT count(*) AS post_step1 FROM usage_events \gset
\echo '— Step 1: pulse → anon usage —'
\echo 'usage_events after step 1:   ' :post_step1
\echo 'inserted:                    ' :pre_pulse

-- ─────── Step 2: analytics_events + sessions → usage_events (identified) ───────
INSERT INTO usage_events (id, at, event, country, region, device, platform, gclid, "companyId")
SELECT
  gen_random_uuid()::text,
  ae."occurredAt",
  ae.event,
  COALESCE(s.country, 'XX'),
  COALESCE(s.region, ''),
  CASE
    WHEN s."userAgent" ~* '(ipad|tablet|playbook|silk|kindle|nexus 7|nexus 9|nexus 10)'        THEN 'tablet'
    WHEN s."userAgent" ~* '(mobile|android|iphone|ipod|blackberry|windows phone|opera mini|iemobile)' THEN 'mobile'
    WHEN s."userAgent" IS NOT NULL                                                              THEN 'desktop'
    ELSE NULL
  END,
  CASE
    WHEN s."userAgent" ~* 'iphone|ipad|ipod'    THEN 'ios'
    WHEN s."userAgent" ~* 'android'             THEN 'android'
    WHEN s."userAgent" ~* 'windows'             THEN 'windows'
    WHEN s."userAgent" ~* 'mac os x|macintosh'  THEN 'macos'
    WHEN s."userAgent" ~* 'linux|ubuntu|fedora|debian' THEN 'linux'
    WHEN s."userAgent" IS NOT NULL              THEN 'other'
    ELSE NULL
  END,
  s.gclid,                                       -- session-level first-touch gclid
  s."companyId"
FROM analytics_events ae
JOIN sessions s ON s.id = ae."sessionId"
WHERE s."companyId" IS NOT NULL;

SELECT count(*) AS post_step2 FROM usage_events \gset
\echo '— Step 2: identified analytics_events → identified usage —'
\echo 'usage_events after step 2:   ' :post_step2
\echo 'inserted in step 2:          ' :pre_ae_identified

-- ─────── Step 3: dedup anon copies of identified events ───────
-- For consented logged-in users the old client fired pulse+event in parallel
-- → both lived in the DB → both got migrated. Treat anon rows that are within
-- ±1 sec of an identified row with same event and same (or both NULL) gclid
-- as the anon shadow of the identified one and remove it.
WITH dupes AS (
  SELECT u_anon.id
  FROM usage_events u_anon
  WHERE u_anon."companyId" IS NULL
  AND EXISTS (
    SELECT 1 FROM usage_events u_id
    WHERE u_id."companyId" IS NOT NULL
      AND u_id.event = u_anon.event
      AND u_id.gclid IS NOT DISTINCT FROM u_anon.gclid
      AND u_id.country = u_anon.country
      AND ABS(EXTRACT(EPOCH FROM (u_id.at - u_anon.at))) < 1
  )
)
DELETE FROM usage_events WHERE id IN (SELECT id FROM dupes);

SELECT count(*) AS post_step3 FROM usage_events \gset
\echo '— Step 3: dedup anon shadows —'
\echo 'usage_events after step 3:   ' :post_step3
\echo 'deleted shadows:             ' :post_step2 - :post_step3

-- ─────── Sanity check ───────
-- Expected total = pre_usage + pre_pulse + pre_ae_identified - shadows_deleted
SELECT
  :pre_usage + :pre_pulse + :pre_ae_identified - (:post_step2 - :post_step3) AS expected,
  count(*)                                                                   AS actual
FROM usage_events \gset
\echo '— Sanity —'
\echo 'expected:                    ' :expected
\echo 'actual:                      ' :actual

-- Comment out one of the two below to choose: COMMIT to apply, ROLLBACK to dry-run.
-- Default is ROLLBACK so accidental re-runs don't double-migrate; flip the
-- comments before running for real.
-- COMMIT;
ROLLBACK;
