-- Ephemeral demo accounts: isDemo gates email/billing suppression and the
-- "save your menu" banner; demoCreatedAt drives the cleanup cron; claimEmail
-- holds the real email entered during the demo→real claim flow.
ALTER TABLE "users" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "demoCreatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "claimEmail" TEXT;

-- Cleanup cron scans demo rows by age — index the two columns it filters on.
CREATE INDEX "users_isDemo_demoCreatedAt_idx" ON "users"("isDemo", "demoCreatedAt");
