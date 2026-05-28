-- Stage C: drop the Company-era tables and every companyId column.
-- The per-restaurant billing model (20260528180000_billing_per_restaurant)
-- already moved plan/subscription/trial onto Restaurant, stripeCustomerId +
-- email-campaign fields onto User, and introduced RestaurantUser. After this
-- migration the schema has no Company / UserCompany / RestaurantAccess /
-- GoogleAdsExclusion tables and no companyId columns anywhere.
--
-- Apply order matters:
--  1. drop FKs/indexes
--  2. backfill support_messages.restaurantId from companyId BEFORE the column is dropped
--  3. drop the companyId columns
--  4. tighten support_messages.restaurantId to NOT NULL
--  5. drop the legacy tables
--
-- prisma migrate deploy wraps the whole file in a single transaction, so a
-- failure at any step rolls back everything atomically.

-- ── 1. Drop FK constraints ────────────────────────────────────────────────
ALTER TABLE "restaurants" DROP CONSTRAINT IF EXISTS "restaurants_companyId_fkey";
ALTER TABLE "categories"  DROP CONSTRAINT IF EXISTS "categories_companyId_fkey";
ALTER TABLE "items"       DROP CONSTRAINT IF EXISTS "items_companyId_fkey";
ALTER TABLE "page_views"  DROP CONSTRAINT IF EXISTS "page_views_companyId_fkey";
ALTER TABLE "support_messages" DROP CONSTRAINT IF EXISTS "support_messages_companyId_fkey";
ALTER TABLE "users_companies"   DROP CONSTRAINT IF EXISTS "users_companies_userId_fkey";
ALTER TABLE "users_companies"   DROP CONSTRAINT IF EXISTS "users_companies_companyId_fkey";
ALTER TABLE "restaurant_access" DROP CONSTRAINT IF EXISTS "restaurant_access_userId_fkey";
ALTER TABLE "restaurant_access" DROP CONSTRAINT IF EXISTS "restaurant_access_restaurantId_fkey";

-- ── 2. Drop indexes on companyId ──────────────────────────────────────────
DROP INDEX IF EXISTS "restaurants_companyId_idx";
DROP INDEX IF EXISTS "categories_companyId_idx";
DROP INDEX IF EXISTS "categories_companyId_sortOrder_idx";
DROP INDEX IF EXISTS "categories_companyId_isActive_sortOrder_idx";
DROP INDEX IF EXISTS "categories_companyId_parentId_sortOrder_idx";
DROP INDEX IF EXISTS "items_companyId_idx";
DROP INDEX IF EXISTS "items_companyId_categoryId_idx";
DROP INDEX IF EXISTS "items_companyId_isExample_idx";
DROP INDEX IF EXISTS "page_views_companyId_createdAt_idx";
DROP INDEX IF EXISTS "page_views_companyId_sessionId_idx";
DROP INDEX IF EXISTS "support_messages_companyId_createdAt_idx";
DROP INDEX IF EXISTS "usage_events_companyId_at_idx";
DROP INDEX IF EXISTS "orders_companyId_status_idx";
DROP INDEX IF EXISTS "orders_companyId_createdAt_idx";
DROP INDEX IF EXISTS "devices_companyId_idx";

-- ── 3. Backfill support_messages.restaurantId from companyId ──────────────
-- Must run BEFORE the column drop. For each company we pick the
-- earliest-created restaurant — historical support threads were Company-level
-- so we collapse them onto the company's "primary" restaurant. Admin replies
-- use the same mapping because they belong to the same Company-level thread.
UPDATE "support_messages" sm
   SET "restaurantId" = (
     SELECT r."id"
       FROM "restaurants" r
      WHERE r."companyId" = sm."companyId"
   ORDER BY r."createdAt" ASC
      LIMIT 1
   )
 WHERE sm."restaurantId" IS NULL
   AND sm."companyId" IS NOT NULL;

-- Anything still NULL has no resolvable restaurant (company already deleted
-- with no surviving restaurants). Drop these orphans so the NOT NULL
-- constraint we add below can be enforced.
DELETE FROM "support_messages" WHERE "restaurantId" IS NULL;

-- ── 4. Drop companyId columns ─────────────────────────────────────────────
ALTER TABLE "restaurants"      DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "categories"       DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "items"            DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "page_views"       DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "support_messages" DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "usage_events"     DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "orders"           DROP COLUMN IF EXISTS "companyId";
ALTER TABLE "devices"          DROP COLUMN IF EXISTS "companyId";

-- ── 5. Tighten support_messages.restaurantId to NOT NULL ──────────────────
-- Safe now that step 3 backfilled or deleted every NULL row.
ALTER TABLE "support_messages" ALTER COLUMN "restaurantId" SET NOT NULL;

-- ── 6. Drop legacy tables ─────────────────────────────────────────────────
DROP TABLE IF EXISTS "users_companies";
DROP TABLE IF EXISTS "restaurant_access";
DROP TABLE IF EXISTS "google_ads_exclusions";
DROP TABLE IF EXISTS "companies";
