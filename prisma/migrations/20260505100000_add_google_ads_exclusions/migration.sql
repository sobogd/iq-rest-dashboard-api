CREATE TABLE "google_ads_exclusions" (
  "id" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "matchType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "google_ads_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_ads_exclusions_keyword_matchType_key" ON "google_ads_exclusions"("keyword", "matchType");
