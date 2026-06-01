// Public-menu currency by country. This is what guests see on the restaurant's
// menu — NOT the IQ Rest billing currency (that's the limited set in stripe.ts).
// Broad map covering the markets we target plus majors; everything unknown
// falls back to EUR. Set once at onboarding from geo; the owner can change it
// later in settings.
const MENU_CURRENCY_BY_COUNTRY: Record<string, string> = {
  // Eurozone
  ES: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", PT: "EUR", NL: "EUR", BE: "EUR",
  AT: "EUR", IE: "EUR", FI: "EUR", GR: "EUR", SK: "EUR", SI: "EUR", EE: "EUR",
  LV: "EUR", LT: "EUR", LU: "EUR", CY: "EUR", MT: "EUR", HR: "EUR",
  // Nordics (non-euro)
  NO: "NOK", SE: "SEK", DK: "DKK", IS: "ISK",
  // Rest of Europe
  GB: "GBP", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", CH: "CHF",
  UA: "UAH", RU: "RUB", TR: "TRY", RS: "RSD",
  // Americas
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CO: "COP", CL: "CLP",
  PE: "PEN", UY: "UYU",
  // Middle East / Asia / Oceania
  AE: "AED", SA: "SAR", IL: "ILS", IN: "INR", JP: "JPY", CN: "CNY", KR: "KRW",
  AU: "AUD", NZ: "NZD",
};

export function getMenuCurrencyByCountry(countryCode: string | null): string {
  if (!countryCode) return "EUR";
  return MENU_CURRENCY_BY_COUNTRY[countryCode.toUpperCase()] ?? "EUR";
}
