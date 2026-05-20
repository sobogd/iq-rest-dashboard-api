import Stripe from "stripe";

let stripeInstance: InstanceType<typeof Stripe> | null = null;

export function getStripe(): InstanceType<typeof Stripe> {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    stripeInstance = new Stripe(key, { typescript: true });
  }
  return stripeInstance;
}

export const PRICE_LOOKUP_KEYS = {
  BASIC_MONTHLY: "basic_monthly",
  BASIC_YEARLY: "basic_yearly",
  PRO_MONTHLY: "pro_monthly",
  PRO_YEARLY: "pro_yearly",
} as const;

export type PriceLookupKey = (typeof PRICE_LOOKUP_KEYS)[keyof typeof PRICE_LOOKUP_KEYS];

// Billing is EUR-only. Other currencies are handled manually via support.
export const SUPPORTED_CURRENCIES = ["EUR"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function getLookupKeyWithCurrency(baseKey: PriceLookupKey, _currency: SupportedCurrency): string {
  // Lookup keys in Stripe are plain (no currency suffix) since we only sell in EUR.
  return baseKey;
}

export function getCurrencyByCountry(_countryCode: string | null): SupportedCurrency {
  return "EUR";
}

export const CURRENCY_INFO: Record<SupportedCurrency, { symbol: string; name: string; symbolPosition: "before" | "after"; zeroDecimal: boolean }> = {
  EUR: { symbol: "€", name: "Euro", symbolPosition: "before", zeroDecimal: false },
};
