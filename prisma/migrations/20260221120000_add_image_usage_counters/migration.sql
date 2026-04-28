-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "imageGenerationsUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "restaurants" ADD COLUMN "imageStylizationsUsed" INTEGER NOT NULL DEFAULT 0;
