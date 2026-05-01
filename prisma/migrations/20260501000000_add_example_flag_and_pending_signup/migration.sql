-- AlterTable: pre-signup context captured before OTP verify; cleared on first verify.
ALTER TABLE "users"
  ADD COLUMN "pendingCuisine" TEXT,
  ADD COLUMN "pendingRestaurantName" TEXT,
  ADD COLUMN "pendingCurrency" TEXT;

-- AlterTable: flag rows seeded by the create-flow template so they can be cleared in one click.
ALTER TABLE "items" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reservations" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tables" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: speeds up the example-status check and Clear examples wipe.
CREATE INDEX "items_companyId_isExample_idx" ON "items"("companyId", "isExample");
