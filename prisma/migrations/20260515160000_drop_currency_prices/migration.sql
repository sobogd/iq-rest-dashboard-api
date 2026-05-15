-- Billing is now EU-only with a single hard-coded EUR plan, so the
-- multi-currency pricing table is no longer referenced anywhere in code.

DROP TABLE IF EXISTS "currency_prices";
