-- AlterTable: add anonymized client IP to usage_events
ALTER TABLE "usage_events" ADD COLUMN "ip" TEXT;
