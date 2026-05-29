-- Internal admin-only note per restaurant. Nullable, free-form text.
ALTER TABLE "restaurants" ADD COLUMN "adminComment" TEXT;
