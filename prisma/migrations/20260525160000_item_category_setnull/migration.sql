-- Deleting a category must not hard-delete its items (orders' dishId +
-- analytics still resolve the row). Make categoryId nullable and switch the
-- FK from ON DELETE CASCADE to ON DELETE SET NULL.
ALTER TABLE "items" ALTER COLUMN "categoryId" DROP NOT NULL;

ALTER TABLE "items" DROP CONSTRAINT "items_categoryId_fkey";

ALTER TABLE "items" ADD CONSTRAINT "items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
