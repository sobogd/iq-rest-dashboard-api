-- Add order-level discount payload + denormalised discount total for analytics.
-- Item-level discounts live inside Order.items JSON; no schema change needed
-- for those.
ALTER TABLE "orders" ADD COLUMN "discount" JSONB;
ALTER TABLE "orders" ADD COLUMN "discountTotal" DECIMAL(10, 2);
