-- Per-day reservation schedule. Array length 7, 0=Mon ... 6=Sun.
-- Null = legacy single-window mode (workingHoursStart/End).
ALTER TABLE "restaurants" ADD COLUMN "reservationSchedule" JSONB;

-- Backfill: for every restaurant, seed all 7 days with the existing
-- single working window, no lunch break, all days open. Owners can
-- then customize per-day or disable individual days.
UPDATE "restaurants"
SET "reservationSchedule" = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'closed', false,
      'from', "workingHoursStart",
      'to', "workingHoursEnd",
      'lunchFrom', NULL,
      'lunchTo', NULL
    )
  )
  FROM generate_series(0, 6)
);
