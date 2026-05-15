-- Add per-restaurant daily order number.
-- Step 1: nullable columns.
ALTER TABLE "orders"
  ADD COLUMN "orderDate" DATE,
  ADD COLUMN "dailyNumber" INTEGER;

-- Step 2: backfill orderDate from createdAt for existing rows.
UPDATE "orders" SET "orderDate" = ("createdAt" AT TIME ZONE 'UTC')::date WHERE "orderDate" IS NULL;

-- Step 3: backfill dailyNumber: rank per (restaurantId, orderDate) by createdAt asc.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY "restaurantId", "orderDate" ORDER BY "createdAt", id) AS rn
  FROM "orders"
)
UPDATE "orders" o
SET "dailyNumber" = ranked.rn
FROM ranked
WHERE o.id = ranked.id;

-- Step 4: enforce NOT NULL.
ALTER TABLE "orders"
  ALTER COLUMN "orderDate" SET NOT NULL,
  ALTER COLUMN "dailyNumber" SET NOT NULL;

-- Step 5: unique constraint.
CREATE UNIQUE INDEX "orders_restaurantId_orderDate_dailyNumber_key"
  ON "orders"("restaurantId", "orderDate", "dailyNumber");
