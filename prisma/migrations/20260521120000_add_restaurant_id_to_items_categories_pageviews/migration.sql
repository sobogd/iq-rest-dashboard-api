-- Phase 0A of multi-restaurant migration.
-- Adds nullable restaurantId to items/categories/page_views and backfills
-- with the primary restaurant per company (first by createdAt). Companies
-- with zero restaurants are skipped — their rows stay NULL (verified empty
-- on local DB; orphan accounts have no menu/page_view data).
-- Phase 0C will later flip these to NOT NULL with FKs once every writer
-- (new dashboard, old dashboard, public menu) sets the column.

ALTER TABLE "categories"  ADD COLUMN "restaurantId" TEXT;
ALTER TABLE "items"       ADD COLUMN "restaurantId" TEXT;
ALTER TABLE "page_views"  ADD COLUMN "restaurantId" TEXT;

WITH primary_restaurant AS (
  SELECT DISTINCT ON ("companyId") "companyId", "id"
  FROM "restaurants"
  ORDER BY "companyId", "createdAt" ASC
)
UPDATE "categories" c
SET "restaurantId" = pr."id"
FROM primary_restaurant pr
WHERE c."companyId" = pr."companyId";

WITH primary_restaurant AS (
  SELECT DISTINCT ON ("companyId") "companyId", "id"
  FROM "restaurants"
  ORDER BY "companyId", "createdAt" ASC
)
UPDATE "items" i
SET "restaurantId" = pr."id"
FROM primary_restaurant pr
WHERE i."companyId" = pr."companyId";

WITH primary_restaurant AS (
  SELECT DISTINCT ON ("companyId") "companyId", "id"
  FROM "restaurants"
  ORDER BY "companyId", "createdAt" ASC
)
UPDATE "page_views" pv
SET "restaurantId" = pr."id"
FROM primary_restaurant pr
WHERE pv."companyId" = pr."companyId";

CREATE INDEX "categories_restaurantId_idx"             ON "categories" ("restaurantId");
CREATE INDEX "categories_restaurantId_sortOrder_idx"   ON "categories" ("restaurantId", "sortOrder");
CREATE INDEX "items_restaurantId_idx"                  ON "items" ("restaurantId");
CREATE INDEX "items_restaurantId_categoryId_idx"       ON "items" ("restaurantId", "categoryId");
CREATE INDEX "page_views_restaurantId_createdAt_idx"   ON "page_views" ("restaurantId", "createdAt");
