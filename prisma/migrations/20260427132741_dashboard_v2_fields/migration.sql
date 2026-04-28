-- Tables: floor-map position
ALTER TABLE "tables"
  ADD COLUMN "x" DOUBLE PRECISION,
  ADD COLUMN "y" DOUBLE PRECISION;

-- Items: option groups (variants like sizes, extras)
ALTER TABLE "items"
  ADD COLUMN "options" JSONB;

-- Restaurants: subtitle and background media type
ALTER TABLE "restaurants"
  ADD COLUMN "subtitle" TEXT,
  ADD COLUMN "backgroundType" TEXT;
