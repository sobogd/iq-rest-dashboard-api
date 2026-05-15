-- Free-form per-table note. Surfaces alongside the zone (name) on the
-- dashboard table form so owners can describe a table beyond just its
-- number ("Booth near the entrance", "By the kitchen pass", etc.).

ALTER TABLE "tables" ADD COLUMN "description" TEXT;
