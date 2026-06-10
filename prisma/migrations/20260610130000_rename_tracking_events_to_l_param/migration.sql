-- Fold the legacy dedicated tracking events into the unified l_param_ namespace.
-- Raw ids are preserved (just re-prefixed). Idempotent: matches only the old
-- prefixes, so a re-run is a no-op.
--   l_fbclid_<raw>  (len 'l_fbclid_' = 9)  -> l_param_fbclid__<raw>
--   l_gclid_<raw>   (len 'l_gclid_'  = 8)  -> l_param_gclid__<raw>
--   l_from_<raw>    (len 'l_from_'   = 7)  -> l_param_from__<raw>
UPDATE "usage_events" SET "event" = 'l_param_fbclid__' || substring("event" from 10) WHERE "event" LIKE 'l_fbclid_%';
UPDATE "usage_events" SET "event" = 'l_param_gclid__'  || substring("event" from 9)  WHERE "event" LIKE 'l_gclid_%';
UPDATE "usage_events" SET "event" = 'l_param_from__'   || substring("event" from 8)  WHERE "event" LIKE 'l_from_%';
