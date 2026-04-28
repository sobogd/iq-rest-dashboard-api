-- CreateTable
CREATE TABLE "restaurants" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT,
    "source" TEXT,
    "address" TEXT,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "phone" TEXT,
    "instagram" TEXT,
    "whatsapp" TEXT,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurants_companyId_idx" ON "restaurants"("companyId");

-- CreateIndex
CREATE INDEX "categories_companyId_idx" ON "categories"("companyId");

-- CreateIndex
CREATE INDEX "categories_companyId_sortOrder_idx" ON "categories"("companyId", "sortOrder");

-- CreateIndex
CREATE INDEX "items_companyId_idx" ON "items"("companyId");

-- CreateIndex
CREATE INDEX "items_categoryId_idx" ON "items"("categoryId");

-- CreateIndex
CREATE INDEX "items_companyId_categoryId_idx" ON "items"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "items_categoryId_sortOrder_idx" ON "items"("categoryId", "sortOrder");

-- AddForeignKey
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
