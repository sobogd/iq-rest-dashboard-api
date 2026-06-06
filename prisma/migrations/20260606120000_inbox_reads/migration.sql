-- Admin-side read markers for unified inbox threads ("wa:<contactId>" / "int:<restaurantId>").
CREATE TABLE "inbox_reads" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbox_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbox_reads_threadId_key" ON "inbox_reads"("threadId");
