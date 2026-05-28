-- Billing-per-restaurant migration (additive).
-- Move plan/subscription/trial fields from Company onto Restaurant; move
-- Stripe customer + email-campaign fields onto User; introduce a flat
-- RestaurantUser join table that supersedes UserCompany + RestaurantAccess.
-- Old tables/columns are NOT dropped yet — kept for safe rollback.
--
-- NOTE: This SQL was applied manually on prod on 2026-05-28 before this file
-- was committed. The migration is marked as applied via
-- `prisma migrate resolve --applied 20260528180000_billing_per_restaurant`
-- during the deploy pipeline so deploy() finds nothing pending here.

-- AlterTable: per-restaurant billing
ALTER TABLE "restaurants"
  ADD COLUMN "plan" TEXT,
  ADD COLUMN "billingCycle" TEXT,
  ADD COLUMN "subscriptionStatus" TEXT NOT NULL DEFAULT 'INACTIVE',
  ADD COLUMN "currentPeriodEnd" TIMESTAMP(3),
  ADD COLUMN "paymentProcessing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "trialEndsAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "restaurants_stripeSubscriptionId_key" ON "restaurants"("stripeSubscriptionId");

-- AlterTable: Stripe customer + email-campaign fields on User
ALTER TABLE "users"
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "emailsSent" JSONB,
  ADD COLUMN "emailUnsubscribed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "upsellShownAt" TIMESTAMP(3),
  ADD COLUMN "reminderSentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_stripeCustomerId_key" ON "users"("stripeCustomerId");

-- CreateTable: RestaurantUser m2m
CREATE TABLE "restaurant_users" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "addedBy" TEXT,
  CONSTRAINT "restaurant_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_users_restaurantId_userId_key" ON "restaurant_users"("restaurantId", "userId");
CREATE INDEX "restaurant_users_userId_idx" ON "restaurant_users"("userId");
CREATE INDEX "restaurant_users_restaurantId_idx" ON "restaurant_users"("restaurantId");

ALTER TABLE "restaurant_users" ADD CONSTRAINT "restaurant_users_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_users" ADD CONSTRAINT "restaurant_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: per-restaurant support chat
ALTER TABLE "support_messages" ADD COLUMN "restaurantId" TEXT;
CREATE INDEX "support_messages_restaurantId_createdAt_idx" ON "support_messages"("restaurantId", "createdAt");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: usage_events get userId + restaurantId alongside legacy companyId
ALTER TABLE "usage_events"
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "restaurantId" TEXT;

CREATE INDEX "usage_events_userId_at_idx" ON "usage_events"("userId", "at");
CREATE INDEX "usage_events_restaurantId_at_idx" ON "usage_events"("restaurantId", "at");
