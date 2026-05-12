-- CreateTable
CREATE TABLE "gads_keyword_sort" (
    "id" TEXT NOT NULL,
    "adGroupId" TEXT NOT NULL,
    "critId" TEXT NOT NULL,
    "sortIndex" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gads_keyword_sort_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gads_keyword_sort_adGroupId_critId_key" ON "gads_keyword_sort"("adGroupId", "critId");

-- CreateIndex
CREATE INDEX "gads_keyword_sort_adGroupId_sortIndex_idx" ON "gads_keyword_sort"("adGroupId", "sortIndex");
