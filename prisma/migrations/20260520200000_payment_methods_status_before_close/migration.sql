-- Restaurant.paymentMethods — enum codes the restaurant accepts.
ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "paymentMethods" text[] NOT NULL DEFAULT ARRAY['cash','card']::text[];

-- Order.statusBeforeClose — preserves the pre-close status so "Return to kitchen"
-- can restore exactly that. Order.paymentMethodId — selected method at close.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "statusBeforeClose" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paymentMethodId" text;
