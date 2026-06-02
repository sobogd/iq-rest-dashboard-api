-- Drop the legacy "isExample" demo flag. Seeded sample dishes are now marked by
-- their "Sample: …" name instead, and sample orders are no longer seeded, so the
-- column is unused across all services (dashboard-api, public-menu-api, monolith).
-- DROP COLUMN cascades to any index that referenced the column.

-- First delete the demo orders that were previously hidden from revenue analytics
-- via isExample — otherwise dropping the flag would retroactively count them.
DELETE FROM "orders" WHERE "isExample" = true;

ALTER TABLE "items" DROP COLUMN IF EXISTS "isExample";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "isExample";
ALTER TABLE "reservations" DROP COLUMN IF EXISTS "isExample";
ALTER TABLE "tables" DROP COLUMN IF EXISTS "isExample";
