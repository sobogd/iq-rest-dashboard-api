-- CreateTable: cross-company restaurant grant (contractor manages a restaurant
-- owned by another company). Restaurant.companyId (owner) is unchanged.
CREATE TABLE "restaurant_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'manager',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_access_userId_idx" ON "restaurant_access"("userId");

-- CreateIndex
CREATE INDEX "restaurant_access_restaurantId_idx" ON "restaurant_access"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_access_userId_restaurantId_key" ON "restaurant_access"("userId", "restaurantId");

-- AddForeignKey
ALTER TABLE "restaurant_access" ADD CONSTRAINT "restaurant_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_access" ADD CONSTRAINT "restaurant_access_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
