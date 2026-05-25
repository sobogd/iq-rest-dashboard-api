-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN "fbSentEvents" TEXT[] DEFAULT ARRAY[]::TEXT[];
