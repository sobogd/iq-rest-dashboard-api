-- Soft-delete for categories. Deleting a category now sets deletedAt instead
-- of removing the row; its items keep their categoryId and stop rendering.
ALTER TABLE "categories" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "categories_restaurantId_deletedAt_idx" ON "categories"("restaurantId", "deletedAt");
