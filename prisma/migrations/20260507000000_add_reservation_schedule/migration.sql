-- Per-day reservation schedule. Array length 7, 0=Mon ... 6=Sun.
-- Null = legacy single-window mode (workingHoursStart/End).
ALTER TABLE "restaurants" ADD COLUMN "reservationSchedule" JSONB;

-- Backfill: every restaurant gets all 7 days populated with the existing
-- single working window, no lunch break, all days open. Owners can then
-- customize per day or close individual days.
UPDATE "restaurants" r
SET "reservationSchedule" = jsonb_build_array(sub.obj, sub.obj, sub.obj, sub.obj, sub.obj, sub.obj, sub.obj)
FROM (
  SELECT id, jsonb_build_object(
    'closed', false,
    'from', "workingHoursStart",
    'to', "workingHoursEnd",
    'lunchFrom', NULL,
    'lunchTo', NULL
  ) AS obj
  FROM "restaurants"
) sub
WHERE r.id = sub.id;
