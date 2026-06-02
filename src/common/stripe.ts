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

// Billing currencies we actually price in Stripe. EUR is the base/fallback;
// NOK/SEK/DKK have currency-suffixed Stripe prices (e.g. `basic_monthly_nok`).
export const SUPPORTED_CURRENCIES = ["EUR", "NOK", "SEK", "DKK", "MXN", "USD", "AUD"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(c: string | null | undefined): c is SupportedCurrency {
  return !!c && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
}

// EUR keeps the plain lookup key (`basic_monthly`); other currencies append a
// lowercase suffix (`basic_monthly_nok`). Stripe must have a price with that
// exact lookup_key — the checkout falls back to the plain key if missing.
export function getLookupKeyWithCurrency(baseKey: PriceLookupKey, currency: SupportedCurrency): string {
  if (currency === "EUR") return baseKey;
  return `${baseKey}_${currency.toLowerCase()}`;
}

// Billing currency by country: only the Scandinavian trio map to their krone;
// everything else (incl. the eurozone and rest of world) bills in EUR.
const BILLING_CURRENCY_BY_COUNTRY: Record<string, SupportedCurrency> = {
  NO: "NOK",
  SE: "SEK",
  DK: "DKK",
  MX: "MXN",
  US: "USD",
  AU: "AUD",
};

export function getCurrencyByCountry(countryCode: string | null): SupportedCurrency {
  if (!countryCode) return "EUR";
  return BILLING_CURRENCY_BY_COUNTRY[countryCode.toUpperCase()] ?? "EUR";
}

export const CURRENCY_INFO: Record<SupportedCurrency, { symbol: string; name: string; symbolPosition: "before" | "after"; zeroDecimal: boolean }> = {
  EUR: { symbol: "€", name: "Euro", symbolPosition: "before", zeroDecimal: false },
  NOK: { symbol: "kr", name: "Norwegian krone", symbolPosition: "after", zeroDecimal: false },
  SEK: { symbol: "kr", name: "Swedish krona", symbolPosition: "after", zeroDecimal: false },
  DKK: { symbol: "kr", name: "Danish krone", symbolPosition: "after", zeroDecimal: false },
  MXN: { symbol: "MX$", name: "Mexican peso", symbolPosition: "before", zeroDecimal: false },
  USD: { symbol: "$", name: "US Dollar", symbolPosition: "before", zeroDecimal: false },
  AUD: { symbol: "A$", name: "Australian Dollar", symbolPosition: "before", zeroDecimal: false },
};
