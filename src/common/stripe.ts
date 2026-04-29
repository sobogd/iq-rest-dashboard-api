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

export const SUPPORTED_CURRENCIES = [
  "EUR", "USD", "PLN", "MXN", "BRL", "ARS", "COP", "CLP", "PEN", "UYU", "TRY",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function getLookupKeyWithCurrency(baseKey: PriceLookupKey, currency: SupportedCurrency): string {
  return `${baseKey}_${currency.toLowerCase()}`;
}

export const COUNTRY_TO_CURRENCY: Record<string, SupportedCurrency> = {
  PL: "PLN",
  MX: "MXN", BR: "BRL", AR: "ARS", CO: "COP", CL: "CLP", PE: "PEN", UY: "UYU",
  TR: "TRY",
  US: "USD",
  ES: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", PT: "EUR", NL: "EUR", BE: "EUR",
  AT: "EUR", IE: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", MT: "EUR", CY: "EUR",
  SK: "EUR", SI: "EUR", EE: "EUR", LV: "EUR", LT: "EUR", HR: "EUR",
};

export function getCurrencyByCountry(countryCode: string | null): SupportedCurrency {
  if (!countryCode) return "EUR";
  return COUNTRY_TO_CURRENCY[countryCode.toUpperCase()] || "EUR";
}

export const CURRENCY_INFO: Record<SupportedCurrency, { symbol: string; name: string; symbolPosition: "before" | "after"; zeroDecimal: boolean }> = {
  EUR: { symbol: "€", name: "Euro", symbolPosition: "before", zeroDecimal: false },
  USD: { symbol: "$", name: "US Dollar", symbolPosition: "before", zeroDecimal: false },
  PLN: { symbol: "zł", name: "Polish Zloty", symbolPosition: "after", zeroDecimal: false },
  MXN: { symbol: "MX$", name: "Mexican Peso", symbolPosition: "before", zeroDecimal: false },
  BRL: { symbol: "R$", name: "Brazilian Real", symbolPosition: "before", zeroDecimal: false },
  ARS: { symbol: "AR$", name: "Argentine Peso", symbolPosition: "before", zeroDecimal: false },
  COP: { symbol: "CO$", name: "Colombian Peso", symbolPosition: "before", zeroDecimal: false },
  CLP: { symbol: "CL$", name: "Chilean Peso", symbolPosition: "before", zeroDecimal: true },
  PEN: { symbol: "S/", name: "Peruvian Sol", symbolPosition: "before", zeroDecimal: false },
  UYU: { symbol: "UY$", name: "Uruguayan Peso", symbolPosition: "before", zeroDecimal: false },
  TRY: { symbol: "₺", name: "Turkish Lira", symbolPosition: "after", zeroDecimal: false },
};
