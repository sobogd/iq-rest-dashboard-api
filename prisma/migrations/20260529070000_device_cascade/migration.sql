-- Add the missing FK from devices.restaurantId → restaurants.id with
-- ON DELETE CASCADE. Without it, deleting a Restaurant left orphan device
-- rows whose tablets kept authenticating against a dead restaurantId.
--
-- The pre-Stage-C schema referenced restaurants via companyId only (devices
-- were cleaned up indirectly through Company cascade). After Stage C the
-- companyId column was dropped, leaving devices unanchored. This migration
-- closes the gap.
--
-- Safe to apply: prod has zero orphan devices today (verified with the same
-- LEFT JOIN check below), so adding the FK can't fail on existing rows.
-- Belt-and-braces: the DELETE below removes any orphans that slipped in
-- between this check and the constraint add.

DELETE FROM "devices" d
 WHERE NOT EXISTS (
   SELECT 1 FROM "restaurants" r WHERE r."id" = d."restaurantId"
 );

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
