-- Collapse referrer_source (TEXT bucket) into is_search (boolean): we only
-- ever needed "did the visit arrive from a search engine" — the finer-grained
-- bucket was never consumed in product. Same shape as is_google_ads.
ALTER TABLE "usage_events" ADD COLUMN "is_search" BOOLEAN NOT NULL DEFAULT false;

-- Carry forward the search signal for SSR first-visit rows. JS-fired rows
-- never participated in the search signal (post-cleanup, they no longer
-- write any visit-origin enrichment), so leave them at the default false.
UPDATE "usage_events"
SET "is_search" = TRUE
WHERE "event" LIKE 'land_page_%'
  AND "referrer_source" IN ('google_search', 'bing', 'yandex', 'duckduckgo', 'yahoo', 'other_search');

-- Zero out visit-origin enrichment on rows that aren't first-visit SSR
-- page-view writes — those columns were previously populated from a
-- client-side flag that we've now removed.
UPDATE "usage_events"
SET "gclid" = NULL, "is_google_ads" = FALSE
WHERE "event" NOT LIKE 'land_page_%';

DROP INDEX IF EXISTS "usage_events_referrer_source_at_idx";
ALTER TABLE "usage_events" DROP COLUMN "referrer_source";

CREATE INDEX "usage_events_is_search_at_idx" ON "usage_events" ("is_search", "at");
