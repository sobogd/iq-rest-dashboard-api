-- Phase 0C of multi-restaurant migration. Locks restaurantId NOT NULL +
-- adds FK constraint with cascade-delete to restaurants. Applied after
-- Phase 1 (dashboard-api), Phase 2 (soqrmenuweb) and Phase 3
-- (iq-rest-public-menu-api) all write restaurantId on every insert.
--
-- Pre-check (verified before applying):
--   SELECT COUNT(*) FROM categories  WHERE "restaurantId" IS NULL;  -- 0
--   SELECT COUNT(*) FROM items       WHERE "restaurantId" IS NULL;  -- 0
--   SELECT COUNT(*) FROM page_views  WHERE "restaurantId" IS NULL;  -- 0

ALTER TABLE "categories"
  ALTER COLUMN "restaurantId" SET NOT NULL,
  ADD CONSTRAINT "categories_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "items"
  ALTER COLUMN "restaurantId" SET NOT NULL,
  ADD CONSTRAINT "items_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_views"
  ALTER COLUMN "restaurantId" SET NOT NULL,
  ADD CONSTRAINT "page_views_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
