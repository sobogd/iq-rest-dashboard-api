-- Soft-delete columns for menu items, tables, and orders. NULL = active;
-- non-NULL = the timestamp the row was archived. All operational list
-- queries are updated to filter "deletedAt IS NULL"; historical lookups
-- (admin timeline, analytics aggregates) keep seeing every row.

ALTER TABLE "tables" ADD COLUMN "deletedAt" TIMESTAMP;
ALTER TABLE "items"  ADD COLUMN "deletedAt" TIMESTAMP;
ALTER TABLE "orders" ADD COLUMN "deletedAt" TIMESTAMP;

-- Partial indexes keep the active-row reads fast as deleted rows accumulate.
CREATE INDEX "tables_active_idx" ON "tables" ("restaurantId") WHERE "deletedAt" IS NULL;
CREATE INDEX "items_active_idx"  ON "items"  ("companyId", "categoryId", "sortOrder") WHERE "deletedAt" IS NULL;
CREATE INDEX "orders_active_idx" ON "orders" ("companyId", "createdAt") WHERE "deletedAt" IS NULL;
