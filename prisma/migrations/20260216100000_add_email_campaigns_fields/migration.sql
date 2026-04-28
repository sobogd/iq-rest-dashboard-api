-- AlterTable
ALTER TABLE "companies" ADD COLUMN "emailsSent" JSONB,
ADD COLUMN "emailUnsubscribed" BOOLEAN NOT NULL DEFAULT false;
