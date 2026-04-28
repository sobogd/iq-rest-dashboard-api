-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "checklistMenuEdited" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "checklistContactsSaved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "checklistBrandCustomized" BOOLEAN NOT NULL DEFAULT false;
