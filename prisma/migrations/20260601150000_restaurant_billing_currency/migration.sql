-- Per-restaurant Stripe customer + billing currency. Existing restaurants keep
-- EUR (the default) and their subscriptions stay under User.stripeCustomerId.
ALTER TABLE "restaurants" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "billingCurrency" TEXT NOT NULL DEFAULT 'EUR';
CREATE UNIQUE INDEX "restaurants_stripeCustomerId_key" ON "restaurants"("stripeCustomerId");
