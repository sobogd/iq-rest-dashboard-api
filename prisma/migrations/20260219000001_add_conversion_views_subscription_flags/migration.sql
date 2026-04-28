-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "conversionViewsSent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sessions" ADD COLUMN "conversionSubscriptionSent" BOOLEAN NOT NULL DEFAULT false;
