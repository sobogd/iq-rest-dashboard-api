-- AlterTable: add IANA timezone identifier to restaurants. Defaults to
-- 'UTC' for safety. The dashboard frontend auto-fills the browser's
-- detected timezone on new restaurant create, and a one-off backfill
-- script populates existing rows from their lat/lon (Restaurant.x/y).
ALTER TABLE "restaurants" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
