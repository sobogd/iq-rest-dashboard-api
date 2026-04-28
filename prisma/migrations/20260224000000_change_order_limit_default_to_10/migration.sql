-- AlterTable
ALTER TABLE "companies" ALTER COLUMN "orderLimit" SET DEFAULT 10;

-- Update existing free companies that still have the old default
UPDATE "companies" SET "orderLimit" = 10 WHERE "orderLimit" = 30 AND "plan" = 'FREE';
